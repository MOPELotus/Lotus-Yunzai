import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountCommands, isAccountLoginMutation } from "../lib/account-commands.ts";
import { chatSetting } from "../lib/chat-settings.ts";
import { readGenshinBackpack, readGenshinGrowth, requestStarRailCalculator } from "../packages/hoyo-client/genshin-backpack.ts";
import { getLanguage, registerLanguage, setLanguage } from "../packages/i18n/index.ts";
import type { ProfileRequestContext } from "../packages/account/index.ts";

test("editing action words changes presentation without renaming commands or changing dispatch", async () => {
  const previous = getLanguage();
  const root = await mkdtemp(join(tmpdir(), "lotus-i18n-control-"));
  registerLanguage("en", { core: {
    "lib.chat-settings.text_df3d58c7d8": "Settings",
    "lib.chat-settings.text_6320b4a872": "Status",
    "lib.chat-settings.text_9da9735f47": "Likes",
    "lib.chat-settings.text_dd7cfe9b7b": "Render precision",
    "lib.account-commands.text_db8db05304": "Inspect",
    "lib.account-commands.text_aee8874341": "Refresh",
    "lib.account-commands.text_cb5d682bac": "Reset",
    "lib.account-commands.text_0559412a4e": "Reset is unavailable.",
    "lib.account-commands.text_fcefd5d5a7": "#translated-command{suffix}",
    "lib.account-commands.text_2b8548acc7": "#translated-{verb}",
  } });
  try {
    setLanguage("en");
    expect(chatSetting("#设置")).toEqual({ setting: "设置" });
    expect(chatSetting("#设置状态 开启")).toEqual({ setting: "状态", enabled: true });
    expect(chatSetting("#设置陌生人点赞 关闭")).toEqual({ setting: "陌生人点赞", enabled: false });
    expect(chatSetting("#设置渲染精度 5秒")).toEqual({ setting: "渲染精度" });
    const commands = accountCommands(root, () => true);
    expect(commands.commands["#刷新cookie3"]).toBeFunction();
    expect(commands.aliases?.["#刷新自动签到3"]).toBe("#刷新cookie3");
    expect(commands.aliases?.["#刷新用户ck"]).toBe("#刷新用户缓存");
    expect(isAccountLoginMutation("#刷新自动签到3")).toBe(true);
    expect(isAccountLoginMutation("#删除扫码登录3")).toBe(true);
    expect(await commands.commands["#重置用户缓存"]!("", { message_type: "terminal", isMaster: true })).toBe("Reset is unavailable.");
  } finally { setLanguage(previous); await rm(root, { recursive: true, force: true }); }
});

test("translated calculation labels do not change validation branches or endpoint checks", async () => {
  const previous = getLanguage();
  registerLanguage("en", { "hoyo-client": {
    "genshin-backpack.text_2a3c6b8bff": "Inventory",
    "genshin-backpack.text_d3694c2333": "Growth",
    "genshin-backpack.text_2957fe507f": "Star Rail growth",
    "genshin-backpack.text_3985e7b035": "Invalid inventory probe.",
    "genshin-backpack.text_126e2a3c5f": "Invalid growth target.",
  } });
  const source = {
    qq: "42", profileId: 1, game: "gs", revision: "fixture", account: { cookie: "cookie_token=fixture" },
    device: { id: "fixture-id", fp: "fixture-fp", model: "Fixture", androidVersion: "14" },
    role: { uid: "512345678", region: "cn_qd01", gameBiz: "hk4e_cn", nickname: "", chosen: false },
  } as ProfileRequestContext;
  let calls = 0;
  try {
    setLanguage("en");
    const transport = async () => { calls++; return Response.json({ retcode: 0, data: {} }); };
    await expect(readGenshinBackpack(source, transport, { probe: { items: [] } })).rejects.toMatchObject({ code: "invalid-input", message: "Invalid inventory probe." });
    await expect(readGenshinGrowth(source, transport, { item: { weapon: { id: 1, level_current: 90, level_target: 1 } } })).rejects.toMatchObject({ code: "invalid-input", message: "Invalid growth target." });
    expect(calls).toBe(0);
    const wrongEndpoint = Response.json({ retcode: 0, data: {} });
    Object.defineProperty(wrongEndpoint, "url", { value: "https://unexpected.invalid/calculator" });
    await expect(requestStarRailCalculator(source, async () => wrongEndpoint, "compute", { body: "{}" })).rejects.toMatchObject({ code: "http" });
  } finally { setLanguage(previous); }
});
