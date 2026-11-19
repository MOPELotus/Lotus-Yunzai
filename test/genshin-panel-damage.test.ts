import { expect, test } from "bun:test";
import { ProfileError } from "@lotus-yunzai/account";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { estimatePanelDamage } from "../plugins/genshin/panel/damage.ts";
import { createDamagePreferences, matchEnemyLevel } from "../plugins/genshin/panel/damage-preferences.ts";
import { matchGenshinPanel, type Json, type PanelAvatar } from "../plugins/genshin/panel/model.ts";
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

test("旧伤害序号和绑定档案号相互独立，并保留显式 UID 校验入口", () => {
  expect(matchGenshinPanel("#胡桃伤害2")).toMatchObject({ mode: "damage", damageRow: 2, profileId: 1 });
  expect(matchGenshinPanel("#原神胡桃伤害2 档案3")).toMatchObject({ mode: "damage", damageRow: 2, profileId: 3 });
  expect(matchGenshinPanel("#胡桃伤害2 100123456")).toMatchObject({ mode: "damage", damageRow: 2, uid: "100123456" });
  expect(matchGenshinPanel("#胡桃伤害100123456")).toMatchObject({ mode: "damage", uid: "100123456" });
  expect(matchGenshinPanel("#星铁卡芙卡伤害2")).toBeUndefined();
});

test("原版胡桃旧公式保留低血量、E 攻击力增益、蒸发及词条对照", async () => {
  const result = await estimatePanelDamage(avatar, theme());
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
  expect(await estimatePanelDamage(avatar, theme(), 4)).toMatchObject({ message: expect.stringContaining("3种") });
});

test("缺失倍率不会作为零伤害，已知零数值及其他完整情景仍可查询", async () => {
  const partial = await estimatePanelDamage(avatar, theme(actor({ q: false })), 3);
  if (!("rows" in partial)) throw new Error(partial.message);
  expect(partial.selected).toBe(2);
  expect(partial.rows[2]).toEqual({ title: "半血开E后Q", unavailable: true, buffs: [] });
  expect(partial.rows[0]?.average).toBeGreaterThan(0);
  expect(partial.comparison).toBeUndefined();

  const zero = await estimatePanelDamage(avatar, theme(actor({ attack: 0 })), 1);
  if (!("rows" in zero)) throw new Error(zero.message);
  expect(zero.rows[0]).toMatchObject({ average: 0, crit: 0 });
  expect(await estimatePanelDamage({ ...avatar, talent: { ...avatar.talent, e: undefined } }, theme()))
    .toEqual({ message: "天赋等级或旧版倍率表不完整，请先更新面板。" });
  expect(await estimatePanelDamage(avatar, theme(actor(), {}))).toEqual({ message: "旧主题缺少当前武器的属性表。" });
});

test("旧敌人等级命令、场景结果和词条对照使用相同的目标等级", async () => {
  expect(matchEnemyLevel("#敌人等级 0")).toEqual({ profileId: 1, enemyLevel: 0 });
  expect(matchEnemyLevel("#原神怪物等级999 档案 2")).toEqual({ profileId: 2, enemyLevel: 999 });
  for (const invalid of ["#星铁敌人等级80", "#敌人等级1000", "#敌人等级-1", "#怪物等级80 档案256"]) {
    expect(matchEnemyLevel(invalid)).toBeUndefined();
  }
  const original = await estimatePanelDamage(avatar, theme(), 2);
  const changed = await estimatePanelDamage(avatar, theme(), 2, 90);
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

test("普通详情只附有效的伤害表，按同档敌人偏好保留有效零和缺数据情景", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-damage-summary-"));
  const uid = "100123456";
  const role = { uid, nickname: "", region: "cn_gf01", gameBiz: "hk4e_cn", chosen: true };
  let selected = actor({ attack: 0, q: false });
  const detail: Record<string, unknown>[] = [];
  const query = createGenshinPanelQuery({ async savedRole() { return role; },
    async requestContext() { throw new ProfileError("login-required", "只读取已绑定 UID"); },
  }, { async fetchGenshinPanel() { throw new Error("详情不刷新面板"); } }, lockFile, new AbortController().signal, {
    archiveDirectory: join(directory, "panels"), legacyDirectory: directory,
    theme: async () => theme(selected),
    render: {
      async list() { throw new Error("详情不渲染列表"); },
      async detail(_snapshot, _avatar, _theme, options) { detail.push({ ...options }); return { png: new Uint8Array([1]) }; },
    },
  });
  try {
    await mkdir(join(directory, "panels"));
    await writeFile(join(directory, `${uid}.json`), JSON.stringify({ uid, avatars: { 10000046: avatar } }));
    expect(await query("#敌人等级90 档案2", { user_id: 42 })).toBe("敌人等级已经设置为90");
    expect(await query("#胡桃详情2", { user_id: 42 })).toMatchObject({ type: "image" });
    expect(detail[0]).toMatchObject({ pane: "profile", profileId: 2, damage: {
      enemyLevel: 90, enemyName: "小宝", rows: [
        { average: 0, crit: 0 }, { average: 0, crit: 0 }, { unavailable: true },
      ],
    } });
    expect(Object(detail[0]?.damage).comparison).toBeUndefined();
    expect(await query("#胡桃圣遗物2", { user_id: 42 })).toMatchObject({ type: "image" });
    expect(detail[1]).toMatchObject({ pane: "artifacts", damage: undefined });
    selected = {};
    expect(await query("#胡桃面板2", { user_id: 42 })).toMatchObject({ type: "image" });
    expect(detail[2]).toMatchObject({ pane: "profile", damage: undefined });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
