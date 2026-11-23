import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { lockFile } from "../lib/file-lock.ts";
import { wishDefaultPools, wishDefaultRates } from "../lib/genshin-wish-settings-model.ts";
import { readGenshinWishSettings, updateGenshinWishSettings } from "../lib/genshin-wish-settings.ts";
import { stageLegacyGenshinWishConfig } from "../lib/migration-genshin-wish.ts";
import { panelGenshinWishSettings } from "../lib/panel-genshin-wish-settings.ts";
import { rejectionReason } from "../lib/plugins/policy.ts";
import { drawWish, emptySession } from "../plugins/genshin/wish-sim/draw.ts";
import { createWishCommands } from "../plugins/genshin/wish-sim/commands.ts";
import { createWishPoolSource } from "../plugins/genshin/wish-sim/pools.ts";

test("Flower 票数、撤回与转生冷却迁入统一面板，设置与群命令同源", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-wish-pref-"));
  const source = join(directory, "source"), archive = join(directory, "archive"), stage = join(directory, "stage");
  const root = pathToFileURL(stage + "/");
  const legacy = join(archive, "flower-plugin/GachaMOD/Genshin");
  const plugins = [{ path: "plugins/flower-plugin", identity: "flower-plugin", kind: "directory", status: "archive",
    reason: rejectionReason(["flower-plugin"], [])! }] as const;
  try {
    await mkdir(join(source, "plugins/genshin/config"), { recursive: true });
    await mkdir(join(legacy, "config"), { recursive: true });
    await mkdir(join(legacy, "def"), { recursive: true });
    await writeFile(join(legacy, "config/gacha.yaml"), "relifeCD: 17\n");
    const cooldownStage = join(directory, "cooldown-only");
    expect(await stageLegacyGenshinWishConfig(source, archive, cooldownStage, plugins)).toEqual({ active: true, deferred: false });
    expect(await readGenshinWishSettings(pathToFileURL(cooldownStage + "/"))).toMatchObject({ reincarnationMinutes: 17 });
    await writeFile(join(legacy, "config/gacha.yaml"), "delMsg: 3\nrelifeCD: 11\n");
    const privateStage = join(directory, "private-only");
    expect(await stageLegacyGenshinWishConfig(source, archive, privateStage, plugins)).toEqual({ active: true, deferred: false });
    expect(await readGenshinWishSettings(pathToFileURL(privateStage + "/"))).toMatchObject({ privateSingleRecallSeconds: 3, reincarnationMinutes: 11 });
    await writeFile(join(legacy, "def/gacha.yaml"), "relifeCD: 27\n");
    await writeFile(join(legacy, "config/gacha.yaml"), "delMsg: 0\nrelifeCD: 0\n");
    const unsupportedStage = join(directory, "unsupported-cooldown");
    expect(await stageLegacyGenshinWishConfig(source, archive, unsupportedStage, plugins)).toEqual({ active: true, deferred: false });
    expect(await readGenshinWishSettings(pathToFileURL(unsupportedStage + "/"))).toMatchObject({
      privateSingleRecallSeconds: 0, reincarnationMinutes: 27,
    });
    await writeFile(join(legacy, "config/gacha.yaml"), "delMsg: 3\nrelifeCD: 11\n");
    await writeFile(join(source, "plugins/genshin/config/gacha.set.yaml"), "default: { delMsg: 23, count: 1 }\n123: { delMsg: 0 }\n");
    await writeFile(join(legacy, "config/coin.yaml"), "default: { pink: 22, blue: 11 }\n123: { pink: 10 }\n");
    await writeFile(join(legacy, "def/coin.yaml"), "default: { pink: 100, blue: 10 }\n456: { blue: 10 }\n");
    expect(await stageLegacyGenshinWishConfig(source, archive, stage, plugins)).toEqual({ active: true, deferred: false });

    const panel = panelGenshinWishSettings(root);
    const url = "http://localhost/panel/api/settings/native/genshin-wish";
    const values = await (await panel(new Request(url), () => true)).json().then(r => r.values);
    expect(values).toEqual({ ...wishDefaultRates, ...wishDefaultPools, dailyDrawLimits: {}, enabled: true, multiple: true, pink: 22, blue: 11, recallSeconds: 23, privateSingleRecallSeconds: 3, reincarnationMinutes: 11,
      groups: { 123: { pink: 10, recallSeconds: 0 }, 456: { blue: 10 } } });
    const put = (next: unknown, allow: boolean) => panel(new Request(url, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ previous: values, values: next }) }), () => allow);
    expect((await put({ ...values, pink: 1 }, false)).status).toBe(401);
    expect((await put({ ...values, recallSeconds: -1 }, true)).status).toBe(400);
    for (const reincarnationMinutes of [0, 1441, 1.5, "7"]) {
      expect((await put({ ...values, reincarnationMinutes }, true)).status).toBe(400);
    }
    expect((await put({ ...values, pink: 40, reincarnationMinutes: 9, groups: { 123: { ...values.groups["123"], blue: 1 } } }, true)).status).toBe(200);
    expect((await put({ ...values, recallSeconds: 1 }, true)).status).toBe(409);
    expect(await readGenshinWishSettings(root)).toMatchObject({ reincarnationMinutes: 9,
      privateSingleRecallSeconds: 3, groups: { 123: { recallSeconds: 0 } } });

    let roll = 0.999;
    const time = Date.parse("2026-09-06T16:00:00+08:00");
    const command = createWishCommands({
      lockFile, signal: new AbortController().signal, storeDirectory: join(stage, "archive"), now: () => time,
      poolSource: createWishPoolSource({ themeDirectory: "/nonexistent", legacyDirectory: "" }), random: () => roll,
      readSettings: () => readGenshinWishSettings(root),
      saveSettings: (update, active) => updateGenshinWishSettings(root, update, active),
      render: async () => ({ png: Buffer.from("fixture") }) as Awaited<ReturnType<typeof import("../plugins/genshin/wish-sim/card.ts").renderWishCard>>,
    });
    const sent: unknown[] = [];
    const group = { message_type: "group" as const, user_id: 56, group_id: 123, reply: async (text: unknown) => {
      sent.push(text);
      return true;
    } };
    expect(await command("#设置抽卡粉球20", group)).toContain("只有机器人主人");
    expect(await command("#查看蓝球", group)).toContain("成功领取10个纠缠之缘和1个相遇之缘");
    expect(await command("#十连", group)).toMatchObject({ type: "image" });
    expect(await command("#十连", group)).toContain("10抽无五星");
    expect(sent.at(-1)).toMatch(/纠缠之缘不足.*还有0个/u);
    expect(await command("#设置抽卡撤回时间1", { ...group, isMaster: true })).toContain("撤回时间：1 秒");
    expect(await command("#十连", group)).toMatchObject({ type: "recallable", seconds: 1 });
    expect((await readGenshinWishSettings(root)).groups["123"]).toEqual({ pink: 10, blue: 1, recallSeconds: 1 });
    expect(await command("#单抽", { user_id: 57, reply: group.reply })).toMatchObject({ type: "recallable", seconds: 3 });
    expect(await command("#设置抽卡粉球20", { ...group, group_id: 0, isMaster: true })).toContain("无法确认当前群号");
    roll = 0;
    const lucky = { ...group, user_id: 58 };
    expect(await command("#十连", lucky)).toMatchObject({ type: "image" });
    expect(await command("#十连", lucky)).toMatchObject({ type: "recallable", seconds: 1,
      message: expect.stringMatching(/今日模拟抽卡五星：10个\n本周：10个五星/u) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Flower 原神管理共用设置、兼容旧概率存档并在停用时不改写祈愿档", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-wish-admin-"));
  try {
    const source = join(directory, "source"), stage = join(directory, "target"), archive = join(directory, "archive");
    const root = pathToFileURL(stage + "/");
    const legacy = join(archive, "flower-plugin/GachaMOD/Genshin");
    const plugins = [{ path: "plugins/flower-plugin", identity: "flower-plugin", kind: "directory", status: "archive",
      reason: rejectionReason(["flower-plugin"], [])! }] as const;
    await mkdir(source);
    await mkdir(join(legacy, "config"), { recursive: true });
    await mkdir(join(legacy, "def"), { recursive: true });
    await writeFile(join(legacy, "config/gacha.yaml"),
      'enable: false\nmore: false\nchance5: "61"\nchance4: 300.8\nchanceW4: 0\nwai: "88"\ndelMsg: 0\nrelifeCD: 78\n');
    await writeFile(join(legacy, "def/gacha.yaml"), "chanceW5: 75\n");
    expect(await stageLegacyGenshinWishConfig(source, archive, stage, plugins)).toEqual({ active: true, deferred: false });
    expect(await readGenshinWishSettings(root)).toMatchObject({ enabled: false, multiple: false,
      characterFive: 61, characterFour: 300, weaponFive: 75, weaponFour: 0, featuredFive: 88,
      privateSingleRecallSeconds: 0, reincarnationMinutes: 78 });
    const storeDirectory = join(stage, "wish");
    const actualPool = createWishPoolSource({ themeDirectory: "/nonexistent", legacyDirectory: "" });
    let calls = 0;
    const signal = new AbortController().signal;
    const run = createWishCommands({
      lockFile, signal, storeDirectory, now: () => Date.parse("2026-09-06T16:00:00+08:00"), random: () => 0.5,
      readSettings: () => readGenshinWishSettings(root),
      saveSettings: (update, active) => updateGenshinWishSettings(root, update, active),
      poolSource: (...args) => { calls++; return actualPool(...args); },
      render: async () => { throw new Error("检查文字回执"); },
    });
    const requester = { user_id: 42, group_id: 47 };
    const owner = { user_id: 43, isMaster: true, isBotMaster: (id: number) => id === 43 };
    expect(await run("#抽卡设置", requester)).toContain("只有机器人主人");
    expect(await run("#抽卡设置自定义开启", { ...owner, isDelegated: true })).toContain("只有机器人主人");
    expect(await run("#抽卡设置自定义开启", { ...owner, isBotMaster: () => false })).toContain("只有机器人主人");
    expect(await run("#抽卡设置屏蔽词开启", owner)).toBeUndefined();
    for (const command of ["#单抽", "#十连", "#百连"]) expect(await run(command, requester)).toContain("模拟祈愿已关闭");
    expect(calls).toBe(0);
    await expect(stat(storeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await run("#抽卡设置自定义开启", owner)).toContain("祈愿 · 开启");
    expect(await run("#二十连", requester)).toContain("未开启多连");
    expect(calls).toBe(0);
    await expect(stat(storeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await run("#抽卡设置百连开启", owner)).toContain("多连 · 开启");
    expect(await run("#抽卡设置五星角色概率10001", owner)).toContain("0–10000");
    expect(await run("#抽卡设置小保底概率非法", owner)).toContain("整数");
    expect(await run("#抽卡设置五星角色概率10000", owner)).toContain("角色五星 10000/10000");
    expect(await run("#抽卡设置小保底概率100", owner)).toContain("五星小保底：100%");
    expect(await run("#单抽", requester)).toMatch(/5★/u);

    const url = "http://localhost/panel/api/settings/native/genshin-wish";
    const panel = panelGenshinWishSettings(root);
    const previous = await (await panel(new Request(url), () => true)).json().then(result => result.values);
    expect(previous).toMatchObject({ enabled: true, multiple: true, characterFive: 10_000, featuredFive: 100 });
    const patch = (values: unknown) => panel(new Request(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previous, values }) }), () => true);
    expect((await patch({ ...previous, enabled: "false" })).status).toBe(400);
    expect((await patch({ ...previous, featuredFive: -1 })).status).toBe(400);
    expect((await patch({ ...previous, enabled: false, featuredFive: null })).status).toBe(200);
    expect(await run("#十连", requester)).toContain("模拟祈愿已关闭");
    expect(await run("#抽卡设置概率复位", owner)).toContain("五星小保底：50%");
    expect(await readGenshinWishSettings(root)).toMatchObject({ ...wishDefaultRates, featuredFive: 50, enabled: false,
      multiple: true, reincarnationMinutes: 78, privateSingleRecallSeconds: 0 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("原神四稀有度参数和小保底分开，0 概率不绕开保底", async () => {
  const source = createWishPoolSource({ themeDirectory: "/nonexistent", legacyDirectory: "" });
  const role = (await source("role", Date.now()))!;
  const weapon = (await source("weapon", Date.now()))!;
  const off = { characterFive: 0, characterFour: 0, weaponFive: 0, weaponFour: 0, featuredFive: null };
  const high = () => 0.7;
  expect(drawWish(role, emptySession(1), 1, high, { ...off, characterFive: 10_000, featuredFive: 100 })[0])
    .toMatchObject({ star: 5, name: role.up5[0]?.name });
  expect(drawWish(role, emptySession(1), 1, high, { ...off, characterFour: 10_000 })[0]?.star).toBe(4);
  expect(drawWish(weapon, emptySession(1), 1, high, { ...off, weaponFour: 10_000 })[0]?.star).toBe(4);
  const legacy = drawWish(weapon, emptySession(1), 1, high, { ...off, weaponFive: 10_000, featuredFive: 50 })[0];
  expect(legacy?.star).toBe(5);
  expect(weapon.up5.map(item => item.name)).not.toContain(legacy?.name);
  const standard = drawWish(weapon, emptySession(1), 1, high, { ...off, weaponFive: 10_000 })[0];
  expect(weapon.up5.map(item => item.name)).toContain(standard!.name);
  const state = emptySession(1);
  state.role.num5 = 89;
  state.role.isUp5 = true;
  expect(drawWish(role, state, 1, high, off)[0]).toMatchObject({ star: 5, pity: 90, guaranteed: "大保底" });
});

test("Flower 公共手工池迁入，面板与旧名单指令使用同一设置", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-wish-manual-pools-"));
  try {
    const source = join(directory, "source"), stage = join(directory, "target"), archive = join(directory, "archive");
    const root = pathToFileURL(stage + "/");
    const legacy = join(archive, "flower-plugin/GachaMOD/Genshin");
    const plugins = [{ path: "plugins/flower-plugin", identity: "flower-plugin", kind: "directory", status: "archive",
      reason: rejectionReason(["flower-plugin"], [])! }] as const;
    await mkdir(source);
    await mkdir(join(legacy, "config"), { recursive: true });
    await writeFile(join(legacy, "config/gacha.yaml"), "sync: false\ndelMsg: 0\n");
    await writeFile(join(legacy, "config/pool.yaml"), [
      "up5: [琴]", "up5_2: [琴]", "up4: [爱诺, 蓝砚, 爱诺]", "weapon5: [血染荒城, 支离轮光]", "weapon4: [笛剑, 绝弦]",
    ].join("\n"));
    expect(await stageLegacyGenshinWishConfig(source, archive, stage, plugins)).toEqual({ active: true, deferred: false });
    expect(await readGenshinWishSettings(root)).toMatchObject({ automaticPools: false, poolCharacterFive: ["琴"],
      poolCharacterFour: ["爱诺", "蓝砚"], poolWeaponFive: ["血染荒城", "支离轮光"], poolWeaponFour: ["笛剑", "绝弦"],
      privateSingleRecallSeconds: 0 });
    const pools = createWishPoolSource({ themeDirectory: "/unavailable", legacyDirectory: "" });
    const time = Date.parse("2026-09-06T16:00:00+08:00");
    const signal = new AbortController().signal;
    const owner = { user_id: 43, isMaster: true, isBotMaster: (id: number) => id === 43 };
    const user = { user_id: 42, group_id: 8 };
    const run = createWishCommands({ lockFile, signal, storeDirectory: join(stage, "wish"), now: () => time, random: () => 0,
      poolSource: pools, render: async () => { throw new Error("测试文字回执"); },
      readSettings: () => readGenshinWishSettings(root),
      saveSettings: (update, allowed) => updateGenshinWishSettings(root, update, allowed),
    });
    expect(await run("#单抽2", user)).toContain("5★ 琴");
    expect(await run("#抽卡设置五星角色菲林斯", user)).toContain("只有机器人主人");
    expect(await run("#抽卡设置五星角色爱诺", owner)).toContain("星级");
    expect(await run("#抽卡设置五星角色../无效", owner)).toContain("无法确认");
    expect(await run("#抽卡设置五星武器支离轮光", owner)).toContain("两件不同");
    expect(await run("#抽卡设置五星角色菲林斯，伊涅芙", owner)).toContain("手工五星角色：菲林斯、伊涅芙");
    expect(await run("#抽卡设置四星角色蓝砚,爱诺", owner)).toContain("手工四星角色：蓝砚、爱诺");
    expect(await run("#抽卡设置四星武器笛剑，绝弦", owner)).toContain("手工四星武器：笛剑、绝弦");
    expect(await run("#抽卡设置五星武器支离轮光，血染荒城", owner)).toContain("手工五星武器：支离轮光、血染荒城");
    expect(await run("#定轨查询", user)).toContain("支离轮光");
    const beforeSync = await readGenshinWishSettings(root);
    expect((await pools("weapon", time, "42", beforeSync))?.up5.map(item => item.name)).toEqual(["支离轮光", "血染荒城"]);
    expect(await run("#抽卡设置卡池同步开启", owner)).toContain("卡池：自动同步");
    const auto = await readGenshinWishSettings(root);
    expect(auto.poolWeaponFive).toEqual(["支离轮光", "血染荒城"]);
    expect((await pools("weapon", time, "42", auto))?.up5.map(item => item.name)).toEqual(["血染荒城", "支离轮光"]);
    expect(await run("#抽卡设置卡池自动同步关闭", owner)).toContain("卡池：手工");

    const url = "http://localhost/panel/api/settings/native/genshin-wish";
    const panel = panelGenshinWishSettings(root);
    const previous = await (await panel(new Request(url), () => true)).json().then(result => result.values);
    const patch = (values: unknown) => panel(new Request(url, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ previous, values }) }), () => true);
    expect((await patch({ ...previous, poolCharacterFive: ["蓝砚"] })).status).toBe(400);
    expect((await patch({ ...previous, poolCharacterFive: ["琴"] })).status).toBe(200);
    expect((await pools("role2", time, "42", await readGenshinWishSettings(root)))?.up5[0]?.name).toBe("琴");
    expect(await run("#抽卡设置随机卡池", owner)).toContain("卡池：手工");
    const random = await readGenshinWishSettings(root);
    for (const [names, count] of [[random.poolCharacterFive, 2], [random.poolCharacterFour, 3],
      [random.poolWeaponFive, 2], [random.poolWeaponFour, 5]] as const) {
      expect(new Set(names).size).toBe(count);
    }
    const localPools = createWishPoolSource({ themeDirectory: "/unavailable", legacyDirectory: legacy, bannerFile: "" });
    await mkdir(join(legacy, "data/42"), { recursive: true });
    const personal = join(legacy, "data/42/pool.yaml");
    await writeFile(personal, await Bun.file(new URL("../plugins/genshin/wish-sim/flower/pool.yaml", import.meta.url)).text());
    const managed = { ...random, poolCharacterFive: ["琴"], automaticPools: false };
    expect((await localPools("role", time, "42", managed))?.up5[0]?.name).toBe("菲林斯");
    expect((await localPools("role", time, "44", managed))?.up5[0]?.name).toBe("琴");
    const explicit = createWishPoolSource({ themeDirectory: "/unavailable", legacyDirectory: "", bannerFile: personal });
    expect((await explicit("role", time, "44", managed))?.up5[0]?.name).toBe("菲林斯");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
