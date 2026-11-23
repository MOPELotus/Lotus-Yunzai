import { expect, test } from "bun:test";
import { ProfileError } from "@lotus-yunzai/account";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { damageTrialLabel, estimatePanelDamage, estimateTrialDamage, type DamageSummary } from "../plugins/genshin/panel/damage.ts";
import { createDamagePreferences, matchEnemyLevel } from "../plugins/genshin/panel/damage-preferences.ts";
import { matchGenshinPanel, officialPanel, type Json, type PanelAvatar } from "../plugins/genshin/panel/model.ts";
import { createGenshinPanelQuery } from "../plugins/genshin/panel/panel.ts";
import type { PanelTheme } from "../plugins/genshin/panel/theme.ts";

const avatar: PanelAvatar = {
  id: 10000046, name: "胡桃", elem: "pyro", level: 90, promote: 6, cons: 0, _source: "enka",
  talent: { a: 1, e: 1, q: 1 },
  weapon: { name: "新手长枪", level: 90, promote: 6, affix: 1 },
  artis: { 1: { name: "冒险家之花", set: "冒险家", level: 20, star: 5, mainId: 14001, attrIds: [] } },
};
const actor = ({ attack = 270, hpToAttack = 5, q = true } = {}): Json => ({
  name: "胡桃", weapon: "polearm",
  attr: { keys: ["hp", "atk", "def", "cdmg"], details: { "80+": [9000, 190, 500, 10], "90": [10000, 200, 550, 20] } },
  talentData: {
    a: { 重击伤害: [attack] },
    e: { 攻击力提高: [hpToAttack] },
    q: q ? { 低血量时技能伤害: [350] } : { unrelated: [123] },
  },
});
const weapon = { name: "新手长枪", attr: { atk: { "80+": 230, "90": 250 } } };

function theme(data = actor(), asset: Json = weapon): PanelTheme {
  return { characters: {}, artifacts: new Map(), artifactSets: new Map(),
    async metadata(_game, kind) { return kind === "character" ? data : asset; },
    async picture() { return undefined; },
  };
}

function estimateMiaoDamage(avatar: PanelAvatar, assets: PanelTheme, row?: number, enemy?: number) {
  return estimatePanelDamage(avatar, assets, row, enemy, { useMiao: true });
}

test("旧伤害序号和绑定档案号相互独立，并保留显式 UID 校验入口", () => {
  expect(matchGenshinPanel("#胡桃伤害2")).toMatchObject({ mode: "damage", damageRow: 2, profileId: 1 });
  expect(matchGenshinPanel("#原神胡桃伤害2 档案3")).toMatchObject({ mode: "damage", damageRow: 2, profileId: 3 });
  expect(matchGenshinPanel("#胡桃伤害2 100123456")).toMatchObject({ mode: "damage", damageRow: 2, uid: "100123456" });
  expect(matchGenshinPanel("#胡桃伤害100123456")).toMatchObject({ mode: "damage", uid: "100123456" });
  expect(matchGenshinPanel("#星铁卡芙卡伤害2")).toBeUndefined();
});

test("原版胡桃旧公式保留低血量、E 攻击力增益、蒸发及词条对照", async () => {
  const result = await estimateMiaoDamage(avatar, theme());
  if (!("rows" in result)) throw new Error(result.message);
  const hp = 10_000 + 3.885 * (1.875 * 41) * (1.2 + 0.34 * 20) * 2;
  const defense = 190 / 393;
  const base = (450 + hp * 0.05) * 2.7 * 1.33 * defense * 0.9;
  expect(result.enemyLevel).toBe(103);
  expect(result.selected).toBe(1);
  expect(result.rows[0]?.average).toBeCloseTo(base * (1 + 0.05 * 0.7), 8);
  expect(result.rows[0]?.crit).toBeCloseTo(base * 1.7, 8);
  expect(result.rows[1]?.average).toBeCloseTo(base * (1 + 0.05 * 0.7) * 1.5, 8);
  expect(result.rows[1]?.buffs).toContain("胡桃被动：半血获得33%火伤加成");
  expect(result.comparison?.axes).toEqual(["生命值", "攻击力", "暴击率", "暴击伤害", "元素精通"]);
  expect(result.comparison?.cells[0]?.[0]).toEqual({});
  expect(result.comparison?.cells[0]?.[1]?.average).not.toBe(result.rows[1]?.average);
  expect(await estimateMiaoDamage(avatar, theme(), 4)).toMatchObject({ message: expect.stringContaining("3种") });
});

test("缺失倍率不会作为零伤害，已知零数值及其他完整情景仍可查询", async () => {
  const partial = await estimateMiaoDamage(avatar, theme(actor({ q: false })), 3);
  if (!("rows" in partial)) throw new Error(partial.message);
  expect(partial.selected).toBe(2);
  expect(partial.rows[2]).toEqual({ title: "半血开E后Q", unavailable: true, buffs: [] });
  expect(partial.rows[0]?.average).toBeGreaterThan(0);
  expect(partial.comparison).toBeUndefined();

  const zero = await estimateMiaoDamage(avatar, theme(actor({ attack: 0 })), 1);
  if (!("rows" in zero)) throw new Error(zero.message);
  expect(zero.rows[0]).toMatchObject({ average: 0, crit: 0 });
  expect(await estimateMiaoDamage({ ...avatar, talent: { ...avatar.talent, e: undefined } }, theme()))
    .toEqual({ message: "天赋等级或旧版倍率表不完整，请先更新面板。" });
  expect(await estimateMiaoDamage(avatar, theme(actor(), {}))).toEqual({ message: "旧主题缺少当前武器的属性表。" });
});

test("换装试算按同名情景比较两类伤害，保留敌人、词条矩阵和零值边界", async () => {
  const lowered = { ...avatar, artis: { 1: { ...avatar.artis[1]!, level: 4 } } };
  const assets = theme();
  const baseline = await estimateMiaoDamage(avatar, assets, 2, 95);
  const current = await estimateMiaoDamage(lowered, assets, 2, 95);
  const trial = await estimateTrialDamage(avatar, lowered, assets, 2, 95, { useMiao: true });
  const reverse = await estimateTrialDamage(lowered, avatar, assets, 2, 95, { useMiao: true });
  if (!("rows" in baseline) || !("rows" in current) || !("rows" in trial) || !("rows" in reverse)) {
    throw Error(JSON.stringify([baseline, current, trial, reverse].flatMap(result => "message" in result ? [result.message] : [])));
  }
  expect(trial.enemyLevel).toBe(95);
  expect(trial.selected).toBe(current.selected);
  expect(trial.comparison).toEqual(current.comparison);
  for (const [index, value] of trial.rows.entries()) {
    const previous = baseline.rows.find(row => row.title === value.title)!;
    expect(value.average).toBe(current.rows[index]?.average);
    expect(value.trial?.average).toBe(Number(((Number(value.average) / Number(previous.average) - 1) * 100).toFixed(1)));
    expect(damageTrialLabel(value.trial?.crit)).toMatch(/^↓ \d+\.\d%$/u);
  }
  expect(damageTrialLabel(reverse.rows[0]?.trial?.average)).toMatch(/^↑ \d+\.\d%$/u);
  const equal = await estimateTrialDamage(avatar, avatar, assets, 1, 95, { useMiao: true });
  const zero = await estimateTrialDamage(avatar, lowered, theme(actor({ attack: 0 })), 1, 95, { useMiao: true });
  if (!("rows" in equal) || !("rows" in zero)) throw Error("缺少零值测试");
  expect(damageTrialLabel(equal.rows[0]?.trial?.average)).toBe("0.0%");
  expect(zero.rows[0]?.trial).toBeUndefined();
});

test("丝柯克的旧档战技加一级，官方面板中的实显等级不重复加成", async () => {
  const thresholds = { e: 3, q: 5 };
  const rankData = Array(13).fill(100);
  rankData[10] = 200;
  const skirk: PanelAvatar = { ...avatar, id: 10000114, name: "丝柯克", elem: "cryo", talent: { a: 10, e: 10, q: 10 } };
  const assets = theme({
    ...actor(), name: skirk.name, talentCons: thresholds,
    talentData: { a: { unused: rankData }, e: { 一段伤害: rankData, 五段伤害: rankData, 重击伤害: rankData },
      q: { 斩击伤害: rankData, 斩击最终段伤害: rankData, 蛇之狡谋加成: rankData,
        "汲取0/1/2/3枚虚境裂隙伤害提升": rankData.map(() => [0, 0, 0, 0]) } },
  });
  const catalog = { ...assets, characters: { [skirk.id]: { name: skirk.name, elem: skirk.elem, talentCons: thresholds } } };
  const builtIn = officialPanel("100123456", [
    { base: { id: skirk.id, level: 90, promote_level: 6, actived_constellation_num: 0 },
      skills: [10, 11, 10].map(level => ({ level, skill_type: 1 })) },
  ], catalog, 1).avatars[skirk.id]!;
  const original = await estimateMiaoDamage(skirk, catalog, 1);
  const lower = await estimateMiaoDamage({ ...skirk, talent: { ...skirk.talent, e: 9 } }, catalog, 1);
  const official = await estimateMiaoDamage({ ...builtIn, weapon: skirk.weapon, artis: skirk.artis }, catalog, 1);
  if (!("rows" in original) || !("rows" in lower) || !("rows" in official)) throw new Error("测试缺少丝柯克旧情景");
  expect(original.rows[0]?.average).toBeCloseTo(Number(lower.rows[0]?.average) * 2, 8);
  expect(official.rows).toEqual(original.rows);
  expect(official.comparison).toEqual(original.comparison);
});

test("夜兰的弓藏保留固定重击减伤，其他技能继续走原伤害核", async () => {
  const yelan = { ...avatar, id: 10000060, name: "夜兰", elem: "hydro" };
  const data = { ...actor(), name: yelan.name, weapon: "bow",
    talentData: { a: { 破局矢伤害: [3] }, e: { 技能伤害: [5] }, q: { 玄掷玲珑伤害: [12] } } };
  const build = (name: string, affix = 1) => estimateMiaoDamage({ ...yelan, weapon: { ...yelan.weapon, name, affix } },
    theme(data, { ...weapon, name }), 1);
  const base = await build("猎弓");
  const rust = await build("弓藏");
  const rustFive = await build("弓藏", 5);
  if (!("rows" in base) || !("rows" in rust) || !("rows" in rustFive)) throw new Error("测试缺少夜兰旧情景");
  expect(rust.rows[0]?.crit).toBeCloseTo(Number(base.rows[0]?.crit) * 0.9, 8);
  expect(rust.rows[0]?.average).toEqual(rustFive.rows[0]?.average);
  expect(rust.rows.slice(1).map(row => row.average)).toEqual(base.rows.slice(1).map(row => row.average));
  expect(rust.comparison?.cells[0]?.[1]?.average).toBeGreaterThan(0);
});

test("旧敌人等级命令、场景结果和词条对照使用相同的目标等级", async () => {
  expect(matchEnemyLevel("#敌人等级 0")).toEqual({ profileId: 1, enemyLevel: 0 });
  expect(matchEnemyLevel("#原神怪物等级999 档案 2")).toEqual({ profileId: 2, enemyLevel: 999 });
  for (const invalid of ["#星铁敌人等级80", "#敌人等级1000", "#敌人等级-1", "#怪物等级80 档案256"]) {
    expect(matchEnemyLevel(invalid)).toBeUndefined();
  }
  const original = await estimateMiaoDamage(avatar, theme(), 2);
  const changed = await estimateMiaoDamage(avatar, theme(), 2, 90);
  if (!("rows" in original) || !("rows" in changed)) throw new Error("测试面板缺少伤害结果");
  const multiplier = 393 / 380;
  expect(changed.enemyLevel).toBe(90);
  expect(changed.rows[1]?.crit).toBeCloseTo(Number(original.rows[1]?.crit) * multiplier, 8);
  expect(changed.rows[1]?.average).toBeCloseTo(Number(original.rows[1]?.average) * multiplier, 8);
  expect(changed.comparison?.cells[0]?.[1]?.average)
    .toBeCloseTo(Number(original.comparison?.cells[0]?.[1]?.average) * multiplier, 8);
});

const valkey = Bun.which("valkey-server");
test.skipIf(!valkey)("本地敌人等级按 QQ 持久化，继承旧键优先级并保持旧库只读", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-damage-preferences-"));
  const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = socket.port;
  socket.stop(true);
  const server = Bun.spawn([valkey!, "--bind", "127.0.0.1", "--port", String(port),
    "--dir", directory, "--save", "", "--appendonly", "no"], { stdout: "ignore", stderr: "ignore" });
  const endpoint = `redis://127.0.0.1:${port}/3`;
  let admin: InstanceType<typeof Bun.RedisClient> | undefined;
  try {
    for (let attempt = 0; attempt < 100 && !admin; attempt++) {
      const client = new Bun.RedisClient(endpoint, { autoReconnect: false });
      try { await client.connect(); admin = client; } catch { client.close(); await Bun.sleep(20); }
    }
    if (!admin) throw new Error("隔离 Valkey 实例未启动。");
    await admin.send("ACL", ["SETUSER", "preferences", "on", ">read-fixture", "~miao:user-cfg:*", "~genshin:user-cfg:*",
      "+getrange", "+select", "+hello", "+client"]);
    const source = `redis://preferences:read-fixture@127.0.0.1:${port}/3`;
    await admin.set("miao:user-cfg:42", '{"char":{"enemyLv":0},"other":true}');
    await admin.set("genshin:user-cfg:42", '{"char":{"enemyLv":95}}');
    await admin.set("genshin:user-cfg:43", '{"char":{"enemyLv":91}}');
    await admin.set("miao:user-cfg:44", '{"unrelated":true}');
    await admin.set("genshin:user-cfg:44", '{"char":{"enemyLv":92}}');
    await admin.set("miao:user-cfg:45", '{"char":{"enemyLv":"90"}}');
    const signal = new AbortController().signal;
    const settings = createDamagePreferences(directory, lockFile, signal, source);
    expect(await settings.level("42")).toBe(0);
    expect(await settings.level("43")).toBe(91);
    expect(await settings.level("44")).toBe(103);
    await expect(settings.level("45")).rejects.toThrow("无法读取旧敌人等级");
    expect(await settings.level("46")).toBe(103);
    await expect(settings.setLevel("42", 80, async () => { throw new Error("已换绑"); })).rejects.toThrow("已换绑");
    expect(await settings.level("42")).toBe(0);
    expect(await settings.setLevel("42", 90, async () => {})).toBe(90);
    const restarted = createDamagePreferences(directory, lockFile, signal);
    expect(await restarted.level("42")).toBe(90);
    expect(await restarted.level("43")).toBe(103);
    expect(await admin.get("miao:user-cfg:42")).toBe('{"char":{"enemyLv":0},"other":true}');
  } finally {
    admin?.close();
    server.kill();
    await server.exited;
    await rm(directory, { recursive: true, force: true });
  }
});

const calculationFixture = "普通面板命令验证默认洛洛米与旧喵喵伤害模式";

test(calculationFixture, async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-damage-summary-"));
  const uid = "100123456";
  const role = { uid, nickname: "", region: "cn_gf01", gameBiz: "hk4e_cn", chosen: true };
  let selected = actor({ attack: 0, q: false });
  const detail: Record<string, unknown>[] = [];
  const damage: DamageSummary[] = [];
  const query = createGenshinPanelQuery({ async savedRole() { return role; },
    async requestContext() { throw new ProfileError("login-required", "只读取已绑定 UID"); },
  }, { async fetchGenshinPanel() { throw new Error("详情不刷新面板"); } }, lockFile, new AbortController().signal, {
    archiveDirectory: join(directory, "panels"), legacyDirectory: directory,
    theme: async () => theme(selected),
    render: {
      async list() { throw new Error("详情不渲染列表"); },
      async damage(_snapshot, _avatar, _theme, model) { damage.push(model); return { png: new Uint8Array([1]) }; },
      async detail(_snapshot, _avatar, _theme, options) { detail.push({ ...options }); return { png: new Uint8Array([1]) }; },
    },
  });
  try {
    const engine = Bun.env.LOTUS_TEST_GENSHIN_PANEL_DAMAGE_ENGINE;
    if (engine !== "auto" && engine !== "miao") {
      for (const mode of ["auto", "miao"] as const) {
        const config = join(directory, `${mode}.yaml`);
        await writeFile(config, mode === "auto" ? "{}\n" : "engineMode: miao\nlolomicalc: false\n");
        const child = Bun.spawn([process.execPath, "test", import.meta.path, "-t", calculationFixture], {
          stdout: "pipe", stderr: "pipe",
          env: { ...process.env, LOTUS_GENSHIN_DAMAGE_CONFIG: config, LOTUS_TEST_GENSHIN_PANEL_DAMAGE_ENGINE: mode },
        });
        const [status, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        if (status !== 0) throw new Error(`${mode} 面板验证失败\n${stdout}${stderr}`);
        expect(status).toBe(0);
      }
      return;
    }
    await mkdir(join(directory, "panels"));
    await writeFile(join(directory, `${uid}.json`), JSON.stringify({ uid, avatars: { 10000046: avatar } }));
    expect(await query("#敌人等级90 档案2", { user_id: 42 })).toBe("敌人等级已经设置为90");
    if (engine === "auto") {
      expect(await query("#胡桃伤害3 档案2", { user_id: 42 })).toMatchObject({ type: "image" });
      expect(damage[0]).toMatchObject({ selected: 2, enemyLevel: 90, ruleAuthors: ["洛洛米"] });
      const result = damage[0];
      expect(result?.rows[2]).toMatchObject({ title: "「蝶引来生」半血重击蒸发" });
      expect(result?.rows[2]?.average).toBeGreaterThan(0);
      return;
    }
    expect(await query("#胡桃详情2", { user_id: 42 })).toMatchObject({ type: "image" });
    expect(detail[0]).toMatchObject({ pane: "profile", profileId: 2, damage: {
      enemyLevel: 90, enemyName: "小宝", rows: [
        { average: 0, crit: 0 }, { average: 0, crit: 0 }, { unavailable: true },
      ],
    } });
    expect(Object(detail[0]?.damage).comparison).toBeUndefined();
    expect(await query("#胡桃圣遗物2", { user_id: 42 })).toMatchObject({ type: "image" });
    expect(detail[1]).toMatchObject({ pane: "artifacts", damage: undefined });
    await writeFile(join(directory, `${uid}.json`), JSON.stringify({ uid, avatars: { 10000046: { ...avatar, _source: "share" } } }));
    expect(await query("#胡桃伤害 档案2", { user_id: 42 })).toContain("本档案的实际角色面板");
    await writeFile(join(directory, `${uid}.json`), JSON.stringify({ uid, avatars: { 10000046: avatar } }));
    selected = {};
    expect(await query("#胡桃面板2", { user_id: 42 })).toMatchObject({ type: "image" });
    expect(detail[2]).toMatchObject({ pane: "profile", damage: undefined });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
