import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { lockFile } from "../lib/file-lock.ts";
import { readGenshinWishSettings } from "../lib/genshin-wish-settings.ts";
import { parseWishSettings, wishAllowance } from "../lib/genshin-wish-settings-model.ts";
import { stageLegacyGenshinWishConfig } from "../lib/migration-genshin-wish.ts";
import { panelGenshinWishSettings } from "../lib/panel-genshin-wish-settings.ts";
import { rejectionReason } from "../lib/plugins/policy.ts";
import { createWishCommands } from "../plugins/genshin/wish-sim/commands.ts";
import { createWishPoolSource } from "../plugins/genshin/wish-sim/pools.ts";

test("区分 TRSS 示例、显式组数与 Flower 或现代票数来源", async () => {
  const temp = await mkdtemp(join(tmpdir(), "wish-legacy-limit-migration-"));
  try {
    const source = join(temp, "source"), archive = join(temp, "archive");
    const legacyConfig = join(source, "plugins/genshin/config/gacha.set.yaml");
    const flower = join(archive, "flower-plugin/GachaMOD/Genshin");
    const flowerCoins = join(flower, "config/coin.yaml");
    const plugins = [{ path: "plugins/flower-plugin", identity: "flower-plugin", kind: "directory", status: "archive",
      reason: rejectionReason(["flower-plugin"], [])! }] as const;
    await mkdir(join(source, "plugins/genshin/config"), { recursive: true });
    await mkdir(join(flower, "config"), { recursive: true });
    const read = async (name: string) => {
      const stage = join(temp, name);
      expect(await stageLegacyGenshinWishConfig(source, archive, stage, plugins)).toEqual({ active: true, deferred: false });
      return readGenshinWishSettings(pathToFileURL(stage + "/"));
    };

    await writeFile(legacyConfig, "default: { count: 1, LimitSeparate: 0, delMsg: 110 }\n123465: { count: 10, LimitSeparate: 0, delMsg: 110 }\n");
    const vanilla = await read("vanilla");
    expect(vanilla.dailyDrawLimits).toEqual({});
    expect(wishAllowance(vanilla, "89")).toMatchObject({ pink: 100, blue: 10 });
    expect(wishAllowance(vanilla, "123465")).toMatchObject({ pink: 100, blue: 10 });

    await writeFile(legacyConfig, [
      'default: { count: 2, LimitSeparate: "1", delMsg: 110 }',
      "123465: { count: 10, LimitSeparate: 0, delMsg: 0 }",
      "10: { count: 0, LimitSeparate: 0 }",
      "11: { LimitSeparate: 0 }",
      "12: { delMsg: 0 }",
      "13: { count: 3 }",
      "14: { count: 1 }",
      "15: { count: -1, LimitSeparate: nope }",
    ].join("\n"));
    await writeFile(flowerCoins, "default: {pink: 100, blue: 10}\n12: {pink: 55}\n13: {blue: 0}\n");
    const limits = await read("explicit");
    expect(limits.dailyDrawLimits).toEqual({
      default: { count: 2, separate: true }, 10: { count: 0, separate: false },
      11: { count: 2, separate: false }, 12: null, 13: null, 14: { count: 1, separate: true },
    });
    expect(limits.groups["123465"]?.recallSeconds).toBe(0);
    expect(wishAllowance(limits, "13").blue).toBe(0);

    await writeFile(flowerCoins, "default: {pink: 120, blue: 10}\n13: {blue: 0}\n");
    const wallet = await read("wallet-wins");
    expect(wallet.dailyDrawLimits).toEqual({
      10: { count: 0, separate: false }, 11: { count: 2, separate: false }, 14: { count: 1, separate: true },
    });
    expect(wallet.pink).toBe(120);

    await mkdir(join(flower, "def"));
    await writeFile(join(flower, "def/coin.yaml"), "default: {pink: 100, blue: 10}\n14: {pink: 31}\n");
    const adjustedStock = await read("adjusted-flower-stock");
    expect(adjustedStock.dailyDrawLimits).not.toHaveProperty("14");
    expect(wishAllowance(adjustedStock, "14").pink).toBe(31);

    await writeFile(legacyConfig, "default: {count: 1, LimitSeparate: 1}\n123465: {count: 10, LimitSeparate: 0}\n");
    await writeFile(flowerCoins, "default: {pink: 100, blue: 10}\n");
    expect((await read("split-only")).dailyDrawLimits).toEqual({ default: { count: 1, separate: true }, 14: null });

    await mkdir(join(source, "config"));
    const modern = "# 现代本地明确配置\npink: 30\nblue: 0\nrecallSeconds: 0\ndailyDrawLimits: {private: {count: 2, separate: false}}\n";
    await writeFile(join(source, "config/genshin-wish.yaml"), modern);
    const current = await read("modern");
    expect(current.dailyDrawLimits).toEqual({ private: { count: 2, separate: false } });
    expect(current).toMatchObject({ pink: 30, blue: 0, recallSeconds: 0 });
    const target = join(temp, "modern/config/genshin-wish.yaml");
    expect(await readFile(target, "utf8")).toBe(modern);
    await writeFile(join(source, "config/genshin-wish.yaml"), "pink: 11\n");
    await read("modern");
    expect(await readFile(target, "utf8")).toBe(modern);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("次数限制按会话原子结算，整批预检并优先核对自己的粉蓝钱包", async () => {
  const temp = await mkdtemp(join(tmpdir(), "wish-legacy-limit-run-"));
  try {
    const signal = new AbortController().signal;
    let time = Date.parse("2026-09-06T03:59:59+08:00");
    const base = parseWishSettings({ pink: 100, blue: 10, recallSeconds: 0,
      groups: { 54: { blue: 0 } }, dailyDrawLimits: {
        default: { count: 1, separate: false }, 51: { count: 1, separate: true },
        52: null, 53: { count: 0, separate: false }, 54: { count: 0, separate: false },
        private: { count: 2, separate: false },
      } });
    const run = createWishCommands({ lockFile, signal, storeDirectory: temp, now: () => time, random: () => 0.92,
      poolSource: createWishPoolSource({ themeDirectory: "/unavailable", legacyDirectory: "" }),
      readSettings: async () => base, render: async () => { throw new Error("只核普通文字回执与档案数据"); } });
    const u = { user_id: 42, group_id: 50 };
    const readAccount = () => readFile(join(temp, "42/1.json"), "utf8").then(text => JSON.parse(text));
    for (let pull = 0; pull < 9; pull++) expect(await run("#单抽", u)).toContain("抽未出五星");
    const concurrent = await Promise.all([run("#十连", u), run("#武器十连", u)]);
    expect(concurrent.filter(result => String(result).includes("已达到 10 抽上限")).length).toBe(1);
    expect(concurrent.filter(result => String(result).includes("已抽 19 抽")).length).toBe(1);
    const first = await readAccount();
    expect(first.balance.pink).toBe(81);
    const used = first.conversations["50"].today;
    expect(used.normalDraws + used.weaponDraws).toBe(19);

    const split = { ...u, group_id: 51 };
    await run("#十连", split);
    expect(await run("#常驻单抽", split)).toContain("角色与常驻池已达到 10 抽上限");
    await run("#武器十连", split);
    expect(await run("#武器单抽", split)).toContain("武器池已达到 10 抽上限");
    expect(await readAccount()).toMatchObject({ balance: { pink: 61, blue: 10 },
      conversations: { 51: { today: { normalDraws: 10, weaponDraws: 10 } } } });

    expect(await run("#二十连", { ...u, group_id: 52 })).not.toContain("达到");
    expect(await run("#单抽", { ...u, group_id: 53, isMaster: true, isDelegated: true })).toContain("达到 0 抽");
    expect(await run("#单抽", { ...u, group_id: 53, isMaster: true, isBotMaster: () => false })).toContain("达到 0 抽");
    expect(await run("#单抽", { ...u, group_id: 53, isMaster: true, isBotMaster: () => true })).toContain("抽未出五星");
    expect(await run("#常驻单抽", { user_id: 44, group_id: 54 })).toContain("相遇之缘不足");
    expect(await run("#常驻十连", { user_id: 45, group_id: 50 })).toContain("相遇之缘");
    expect(await run("#单抽", { user_id: 45, group_id: 50 })).toContain("已抽 10 抽");
    expect(await run("#二十连", { user_id: 46, message_type: "private" })).not.toContain("达到");
    expect(await run("#单抽", { user_id: 46, message_type: "private" })).toContain("达到 20 抽");
    expect(await run("#单抽", u)).toContain("已抽 19 抽");
    time += 1000;
    expect(await run("#单抽", u)).toContain("今日成功领取100个纠缠之缘");
    expect(await readAccount()).toMatchObject({ balance: { pink: 99, blue: 10 },
      conversations: { 50: { today: { normalDraws: 1, weaponDraws: 0 } } } });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("跨日先到的请求等待卡池时，后完成也只会使用当前事务的日界", async () => {
  const temp = await mkdtemp(join(tmpdir(), "wish-legacy-limit-lock-"));
  try {
    let now = Date.parse("2026-09-06T03:59:59+08:00");
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const official = createWishPoolSource({ themeDirectory: "/unavailable", legacyDirectory: "" });
    const run = createWishCommands({
      lockFile, signal: new AbortController().signal, storeDirectory: temp, now: () => now, random: () => 0.92,
      readSettings: async () => parseWishSettings({ dailyDrawLimits: { default: { count: 1, separate: false } } }),
      poolSource: async (...args) => {
        if (args[0] === "role") { entered.resolve(); await gate.promise; }
        return official(...args);
      },
      render: async () => { throw new Error("只核状态"); },
    });
    const user = { user_id: 42, group_id: 50 };
    const waiting = run("#单抽", user);
    await entered.promise;
    now += 1000;
    expect(await run("#武器十连", user)).toContain("今日成功领取100个纠缠之缘");
    gate.resolve();
    expect(await waiting).toContain("已抽 10 抽");
    expect(await run("#我的粉球", user)).toContain("还有90个纠缠之缘");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("面板可回读、写入或覆盖每个会话限制，0 秒撤回保持现值", async () => {
  const temp = await mkdtemp(join(tmpdir(), "wish-legacy-limit-panel-"));
  try {
    const root = pathToFileURL(temp + "/");
    const panel = panelGenshinWishSettings(root);
    const url = "http://localhost/panel/api/settings/native/genshin-wish";
    const get = () => panel(new Request(url), () => true).then(res => res.json());
    const initial = await get();
    expect(initial.values.dailyDrawLimits).toEqual({});
    const put = (values: unknown, allowed = true) => panel(new Request(url, { method: "PUT", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ previous: initial.values, values }) }), () => allowed);
    const values = { ...initial.values, recallSeconds: 0, dailyDrawLimits: {
      default: { count: 1, separate: false }, 51: null, private: { count: 0, separate: true },
    } };
    expect((await put(values, false)).status).toBe(401);
    expect((await put({ ...values, dailyDrawLimits: { default: { count: 1, separate: 1 } } })).status).toBe(400);
    expect((await put({ ...values, dailyDrawLimits: { notAGroup: null } })).status).toBe(400);
    expect((await put(values)).status).toBe(200);
    expect((await get()).values).toEqual(values);
    expect((await put(values)).status).toBe(409);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
