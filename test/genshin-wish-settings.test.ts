import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { lockFile } from "../lib/file-lock.ts";
import { readGenshinWishSettings, updateGenshinWishSettings } from "../lib/genshin-wish-settings.ts";
import { stageLegacyGenshinWishConfig } from "../lib/migration-genshin-wish.ts";
import { panelGenshinWishSettings } from "../lib/panel-genshin-wish-settings.ts";
import { rejectionReason } from "../lib/plugins/policy.ts";
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
    expect(values).toEqual({ pink: 22, blue: 11, recallSeconds: 23, privateSingleRecallSeconds: 3, reincarnationMinutes: 11,
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
