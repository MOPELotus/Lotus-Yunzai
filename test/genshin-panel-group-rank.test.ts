import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { estimatePanelDamage } from "../plugins/genshin/panel/damage.ts";
import { createGroupPanelRank, type GroupRankContext } from "../plugins/genshin/panel/group-rank.ts";
import { matchGroupPanelRank, projectRankAvatar } from "../plugins/genshin/panel/group-rank-model.ts";
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
  for (const raw of ["#芙芙排名统计", "#世界BOSS排行", "#星铁胡桃排行", "#胡桃双爆排行", "#最强胡桃"]) {
    expect(matchGroupPanelRank(raw)).toBeUndefined();
  }
  const result = await projectRankAvatar(avatar, theme);
  const estimate = await estimatePanelDamage(avatar, theme, 2, 103);
  if (!("rows" in estimate)) throw new Error(estimate.message);
  const expected = estimate.rows[1];
  if (!expected || typeof expected.average !== "number") throw new Error("测试场景缺少原版伤害值");
  expect(result?.damage).toEqual({ title: expected.title, score: expected.average });
  expect(result?.artifacts?.score).toBeGreaterThan(0);
  expect(await projectRankAvatar({ ...avatar, _source: "change" }, theme)).toBeUndefined();
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
  } }, lockFile, new AbortController().signal, { groups: "77,78", async render(_name, _mode, rows) {
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
