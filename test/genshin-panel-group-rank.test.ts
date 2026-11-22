import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { estimatePanelDamage } from "../plugins/genshin/panel/damage.ts";
import { scorePanelArtifacts } from "../plugins/genshin/panel/artifact-score.ts";
import { createGroupPanelRank, type GroupRankContext } from "../plugins/genshin/panel/group-rank.ts";
import { createGenshinPanelArchive } from "../plugins/genshin/panel/panel.ts";
import { decodeRankAvatar, displayedRankScore, legacyAffixRankScores, matchGroupPanelRank, projectRankAvatar } from "../plugins/genshin/panel/group-rank-model.ts";
import type { PanelAvatar } from "../plugins/genshin/panel/model.ts";
import type { PanelTheme } from "../plugins/genshin/panel/theme.ts";

const avatar: PanelAvatar = {
  id: 10000046, name: "胡桃", elem: "pyro", level: 90, promote: 6, cons: 0, _source: "enka",
  talent: { a: 1, e: 1, q: 1 },
  weapon: { name: "新手长枪", level: 90, promote: 6, affix: 1 },
  artis: { 1: { name: "冒险家之花", set: "冒险家", level: 20, star: 5, mainId: 14001, attrIds: ["501224", "501204"] } },
};
const theme: PanelTheme = {
  characters: {}, artifacts: new Map(), artifactSets: new Map(), async picture() { return undefined; },
  async metadata(_game, kind) {
    if (kind === "character") return { name: "胡桃", weapon: "polearm",
      attr: { keys: ["hp", "atk", "def", "cdmg"], details: { "80+": [9000, 190, 500, 10], "90": [10000, 200, 550, 20] } },
      talentData: { a: { 重击伤害: [270] }, e: { 攻击力提高: [5] }, q: { 低血量时技能伤害: [350] } },
    };
    return { name: "新手长枪", attr: { atk: { "80+": 230, "90": 250 } } };
  },
};

test("原神旧角色排名别名及 103 级默认情景，排除公开统计与预设面板", async () => {
  expect(matchGroupPanelRank("#群内胡桃排名榜")).toMatchObject({ character: { id: 10000046 }, mode: "damage" });
  expect(matchGroupPanelRank("#原神芙芙圣遗物评分排行")).toMatchObject({ character: { id: 10000089 }, mode: "artifacts" });
  expect(matchGroupPanelRank("#原神群内芙芙双爆排行")).toMatchObject({ character: { id: 10000089 }, mode: "crit" });
  expect(matchGroupPanelRank("#胡桃双暴词条排行")).toMatchObject({ character: { id: 10000046 }, mode: "crit" });
  expect(matchGroupPanelRank("#加权有效词条胡桃排名榜")).toMatchObject({ character: { id: 10000046 }, mode: "valid" });
  expect(matchGroupPanelRank("#胡桃词条排行")).toMatchObject({ character: { id: 10000046 }, mode: "valid" });
  expect(matchGroupPanelRank("#最强胡桃")).toMatchObject({ character: { id: 10000046 }, mode: "damage", strongest: true });
  for (const raw of ["#芙芙排名统计", "#世界BOSS排行", "#星铁胡桃排行", "#双暴胡桃词条排行", "#极限胡桃"]) {
    expect(matchGroupPanelRank(raw)).toBeUndefined();
  }
  const result = await projectRankAvatar(avatar, theme);
  const estimate = await estimatePanelDamage(avatar, theme, undefined, 103, { includeComparison: false });
  if (!("rows" in estimate)) throw new Error(estimate.message);
  const expected = estimate.rows.find(row => row.title === "「蝶引来生」半血重击蒸发");
  if (!expected || typeof expected.average !== "number") throw new Error("测试场景缺少原版伤害值");
  expect(result?.damage).toEqual({ title: expected.title, score: expected.average });
  expect(result?.artifacts?.score).toBeGreaterThan(0);
  expect(await projectRankAvatar({ ...avatar, _source: "change" }, theme)).toBeUndefined();
});

test("旧双暴与有效词条使用原权重、固定头部主词条、全量精度排序数值", async () => {
  const { rating } = await scorePanelArtifacts(avatar, theme);
  if (!rating) throw new Error("测试缺少有效圣遗物词条");
  const scores = legacyAffixRankScores(rating);
  const piece = rating.items["1"]!;
  const expected = piece.subs.reduce((sum, attr) => sum + (rating.weights[attr.key]?.mark ?? 0) * attr.value / 85, 0);
  expect(scores.crit).toBe(expected);
  expect(scores.valid).toBe(expected);
  const mainOnly = { ...rating, items: { "5": { ...piece, main: { key: "cdmg", value: 62.2 }, subs: [] } } };
  expect(legacyAffixRankScores(mainOnly)).toEqual({ crit: 9.41, valid: 0 });
  const result = await projectRankAvatar(avatar, theme);
  if (!result) throw new Error("测试未生成排行摘要");
  expect(displayedRankScore(result, "crit")).toBe(expected * 6.6044);
  expect(decodeRankAvatar({ ...result, crit: undefined, valid: undefined })).toMatchObject({ artifacts: result.artifacts });
  expect(decodeRankAvatar({ ...result, crit: { score: 0 }, valid: { score: 0 } })?.crit).toBeUndefined();
  const unknown = await projectRankAvatar({ ...avatar, artis: { 1: { ...avatar.artis["1"]!, scoreReady: false } } }, theme);
  expect(unknown?.crit).toBeUndefined();
  expect(unknown?.valid).toBeUndefined();
});

test("群榜只取本群主动展示的摘要，查榜期间离群或切档不返回排行", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-group-rank-"));
  const role = (uid: string) => ({ uid, region: "cn_gf01", gameBiz: "hk4e_cn", chosen: true, nickname: "" });
  const records = { 42: role("100123456"), 43: role("100123457"), 44: role("100123458") };
  let departed: number | undefined;
  let phase: "leave" | "change" | undefined;
  let exposed: string[] = [];
  const revision = new Map<number, string>();
  const ranking = createGroupPanelRank(directory, { async describe(qq) {
    const item = records[Number(qq) as keyof typeof records];
    const uid = revision.get(Number(qq)) ?? item?.uid;
    return { loggedIn: qq !== "44", roles: { gs: uid ? [role(uid)] : [] }, activeRoles: { gs: uid } };
  } }, lockFile, new AbortController().signal, { groups: "77,78",
    async readSelector() { return "0"; },
    async readShowcase(role) { return { uid: role.uid, avatars: { [avatar.id]: { ...avatar, _source: "mgg" } } }; },
    async render(_name, _mode, rows) {
    exposed = rows.map(row => row.uid);
    if (phase === "leave") departed = 43;
    if (phase === "change") revision.set(43, "100123459");
    return { png: new Uint8Array([1]) };
  } });
  const scope = (qq: number, group = 77, bot = 99, adapter?: string): GroupRankContext => ({
    user_id: qq, self_id: bot, group_id: group, message_type: "group", adapter,
    async listCurrentGroupMembers() { return [bot, 42, 43, 44].filter(id => departed !== id).map(id => ({ id })); },
  });
  const load = async () => theme;
  const observe = (qq: 42 | 43 | 44, ctx = scope(qq), observedAt = 1000) =>
    ranking.observe(ctx, 2, records[qq], avatar, theme, observedAt, async () => {});
  try {
    expect(await ranking.query("#胡桃排行", scope(42, 79), load)).toContain("未启用");
    await observe(42, { ...scope(42), message_type: "private" });
    await observe(42, { ...scope(42), isDelegated: true });
    await observe(43, scope(43, 78));
    await observe(44);
    expect(await ranking.query("#胡桃排行", scope(42), load)).toContain("本群暂无");
    await observe(42);
    expect(await ranking.query("#胡桃排行", scope(42), load)).toMatchObject({ type: "image" });
    expect(exposed).toEqual(["100123456"]);
    const file = join(directory, "onebot", "99", "77", "42.json");
    const encoded = await readFile(file, "utf8");
    expect(encoded).not.toMatch(/attrIds|properties|cookie|nickname|stoken/);
    await cp(file, join(directory, "onebot", "99", "78", "42.json"));
    expect(await ranking.query("#胡桃排行", scope(42, 78), load)).toMatchObject({ type: "image" });
    expect(exposed).toEqual(["100123457"]);
    expect(await ranking.query("#胡桃排行", scope(42, 77, 98), load)).toContain("本群暂无");
    expect(await ranking.query("#胡桃排行", scope(42, 77, 99, "milky"), load)).toContain("本群暂无");
    await observe(43);
    expect(await ranking.query("#胡桃圣遗物评分排行", scope(42), load)).toMatchObject({ type: "image" });
    expect(exposed).toEqual(["100123457", "100123456"]);
    expect(await ranking.query("#胡桃双暴排行", scope(42), load)).toMatchObject({ type: "image" });
    expect(exposed).toEqual(["100123457", "100123456"]);
    expect(await ranking.query("#胡桃词条排行", scope(42), load)).toMatchObject({ type: "image" });
    expect(exposed).toEqual(["100123457", "100123456"]);
    phase = "leave";
    expect(await ranking.query("#胡桃排行", scope(42), load)).toContain("群成员或档案已变化");
    phase = undefined;
    expect(await ranking.query("#胡桃排行", scope(42), load)).toMatchObject({ type: "image" });
    expect(exposed).toEqual(["100123456"]);
    departed = undefined;
    phase = "change";
    expect(await ranking.query("#胡桃排行", scope(42), load)).toContain("群成员或档案已变化");
    phase = undefined;
    expect(await ranking.query("#胡桃排行", scope(42), load)).toMatchObject({ type: "image" });
    expect(exposed).toEqual(["100123456"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("删除面板立即撤回旧榜，随后展示新角色时只计删除后的摘要", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-rank-discard-"));
  const uid = "100123456";
  const role = { uid, region: "cn_gf01", gameBiz: "hk4e_cn", chosen: true, nickname: "" };
  const archive = createGenshinPanelArchive(lockFile, { archiveDirectory: join(directory, "owner"), legacyDirectory: join(directory, "legacy") });
  let discardDuringRender = false;
  let displayed = avatar;
  const verify = async () => {};
  const ranking = createGroupPanelRank(join(directory, "rank"), { async describe() {
    return { loggedIn: true, roles: { gs: [role] }, activeRoles: { gs: uid } };
  } }, lockFile, new AbortController().signal, { groups: "77,78", discardedAt: archive.discardedAt,
    async readSelector() { return "0"; },
    async readShowcase(role) { return { uid: role.uid, avatars: { [displayed.id]: { ...displayed, _source: "mgg" } } }; },
    async render() {
    if (discardDuringRender) await archive.discard("42", uid, () => 3000, verify);
    return { png: new Uint8Array([1]) };
  } });
  const context = { user_id: 42, self_id: 99, group_id: 77, message_type: "group",
    async listCurrentGroupMembers() { return [{ id: 99 }, { id: 42 }]; } };
  const otherGroup = { ...context, group_id: 78 };
  const load = async () => theme;
  const otherAvatar = { ...avatar, id: 10000089, name: "芙宁娜" };
  try {
    await ranking.observe(context, 2, role, avatar, theme, 1000, verify);
    await ranking.observe(otherGroup, 2, role, avatar, theme, 1000, verify);
    expect(await ranking.query("#胡桃双暴排行", context, load)).toMatchObject({ type: "image" });
    const markersBefore = await ranking.listMarkers(context, 2, role, [avatar.id, otherAvatar.id]);
    expect(markersBefore?.markers.get(avatar.id)?.rank).toBe(1);
    expect(await markersBefore?.validate()).toBe(true);
    await archive.discard("42", uid, () => 2000, verify);
    expect(await markersBefore?.validate()).toBe(false);
    expect((await ranking.listMarkers(context, 2, role, [avatar.id]))?.markers.size).toBe(0);
    expect(await ranking.query("#胡桃双暴排行", context, load)).toContain("本群暂无");
    expect(await ranking.query("#胡桃双暴排行", otherGroup, load)).toContain("本群暂无");
    await ranking.observe(context, 2, role, avatar, theme, 1500, verify);
    await ranking.observe(context, 2, role, otherAvatar, theme, 2500, verify);
    displayed = otherAvatar;
    expect(await ranking.query("#胡桃双暴排行", context, load)).toContain("未展示 1 个");
    expect(await ranking.query("#芙宁娜双暴排行", context, load)).toMatchObject({ type: "image" });
    const markersAfter = await ranking.listMarkers(context, 2, role, [avatar.id, otherAvatar.id]);
    expect([...markersAfter?.markers.keys() ?? []]).toEqual([otherAvatar.id]);
    discardDuringRender = true;
    expect(await ranking.query("#芙宁娜双暴排行", context, load)).toContain("重新查询排行");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("刷新所有本群已登记 UID，失效或未展示不使用旧分，榜首复用本轮公开快照", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-rank-fresh-"));
  const role = (qq: number) => ({ uid: String(100123400 + qq), region: "cn_gf01", gameBiz: "hk4e_cn", chosen: true, nickname: "" });
  const seen: string[] = [];
  let ranked: string[] = [];
  let summary: string | undefined;
  let strongest: { uid: string; source: string } | undefined;
  const signal = new AbortController().signal;
  const ranking = createGroupPanelRank(directory, {
    async describe(qq) {
      const current = role(Number(qq));
      return { loggedIn: true, roles: { gs: [current] }, activeRoles: { gs: current.uid } };
    },
  }, lockFile, signal, {
    groups: "77,78",
    async readSelector() { return "0"; },
    async readShowcase(target) {
      seen.push(target.uid);
      if (target.uid === role(44).uid) return;
      if (target.uid === role(45).uid) throw new Error("public source unavailable");
      const gear = avatar.artis["1"]!;
      const publicAvatar = { ...avatar, _source: "mgg", artis: {
        1: target.uid === role(42).uid ? { ...gear, attrIds: ["501224"] } : gear,
      } };
      return { uid: target.uid, avatars: { [avatar.id]: publicAvatar } };
    },
    async render(_name, _mode, rows, _theme, _modeHint, options) {
      ranked = rows.map(row => row.uid);
      summary = options?.refreshSummary;
      return { png: new Uint8Array([1]) };
    },
    async renderStrongest(snapshot, leader, assets) {
      expect(assets.galleryPortrait).toBeUndefined();
      strongest = { uid: snapshot.uid, source: leader._source };
      return { png: new Uint8Array([1]) };
    },
  });
  const context = (qq: number, group = 77): GroupRankContext => ({
    user_id: qq, self_id: 99, group_id: group, message_type: "group",
    async listCurrentGroupMembers() { return [99, 42, 43, 44, 45, 46].map(id => ({ id })); },
  });
  const load = async () => theme;
  try {
    for (const qq of [42, 43, 44, 45, 46]) {
      const observed = qq === 43 ? { ...avatar, id: 10000089, name: "芙宁娜" } : avatar;
      await ranking.observe(context(qq, qq === 46 ? 78 : 77), 1, role(qq), observed, theme, 1000, async () => {});
    }
    await ranking.observe(context(42), 2, role(42), avatar, theme, 1100, async () => {});
    expect(await ranking.query("#胡桃圣遗物排行", context(42), load)).toMatchObject({ type: "image" });
    expect(seen.sort()).toEqual([role(42).uid, role(43).uid, role(44).uid, role(45).uid]);
    expect(ranked).toEqual([role(43).uid, role(42).uid]);
    expect(summary).toContain("可排名 2 个，未展示 1 个，无法刷新或计算 1 个");
    seen.length = 0;
    const result = await ranking.query("#最强胡桃圣遗物", context(42), load);
    expect(result).toEqual([expect.stringContaining(role(43).uid), { type: "image", file: new Uint8Array([1]) }]);
    expect(strongest).toEqual({ uid: role(43).uid, source: "mgg" });
    expect(seen.sort()).toEqual([role(42).uid, role(43).uid, role(44).uid, role(45).uid]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
