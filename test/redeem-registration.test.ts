import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "@lotus-yunzai/account";
import { CommandRegistry } from "../lib/commands.ts";
import type { MessageEvent } from "../lib/messages.ts";
import { redeemCodeCommands } from "../lib/redeem-code-commands.ts";
import { createPreviewRedeemRunner } from "../lib/redeem-code-runner.ts";

function event(patch: Partial<MessageEvent> = {}): MessageEvent {
  const msg = "#注册自动兑换前瞻";
  return { msg, message: msg, raw_message: msg, post_type: "message", message_type: "private",
    isPrivate: true, isGroup: false, isMaster: false, self_id: 99, user_id: 42, reply: () => true,
    privateCredentialSignal: new AbortController().signal, ...patch };
}

async function fixture(run: (root: string, profiles: ReturnType<typeof createProfileStore>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-preview-register-"));
  try {
    await writeFile(join(root, "42.yaml"), "profile: {id: 1}\naccount: {cookie: old, stoken: token}\nauto_redeem: {enable: true, games: [gs]}\n");
    await run(root, createProfileStore(root));
  } finally { await rm(root, { recursive: true, force: true }); }
}

function commands(profiles: ReturnType<typeof createProfileStore>, canRegister: () => boolean) {
  const registry = new CommandRegistry();
  registry.registerModule(redeemCodeCommands({}, undefined, {
    profiles, canRegister, signal: new AbortController().signal, hasHistory: async () => false,
  }));
  return (input = event()) => registry.dispatchFallback(input, () => true, () => false);
}

test("旧档普通保存仍阻止无账本运行，本人显式注册恢复扫描且保留历史记录", async () => {
  await fixture(async (root, profiles) => {
    let settings = await profiles.previewRedeemSettings("42", 1);
    await profiles.setPreviewRedeemSettings("42", 1, settings.revision, true, ["gs"]);
    settings = await profiles.previewRedeemSettings("42", 1);
    expect(settings.allowNewJournal).toBe(false);
    let lookups = 0;
    const journal = join(root, "auto.json");
    const runner = createPreviewRedeemRunner({ journal, listProfiles: profiles.listPreviewRedeemProfiles,
      lookup: async () => { lookups++; return {}; }, readRoles: async () => undefined });
    await runner.scan();
    expect(lookups).toBe(0);
    expect(await commands(profiles, () => true)()).toContain("已开启");
    expect((await profiles.previewRedeemSettings("42", 1)).allowNewJournal).toBe(true);
    await runner.scan();
    expect(lookups).toBe(3);
    const key = createHash("sha256").update("existing-uncertain-redemption").digest("hex");
    const previous = JSON.stringify({ [key]: { time: 123, status: "started" } });
    await writeFile(journal, previous);
    expect(await commands(profiles, () => true)()).toContain("已开启");
    expect(await readFile(journal, "utf8")).toBe(previous);
  });
});

test("已有enable:true的缺账本档也必须通过注册权限及本人可信会话校验", async () => {
  await fixture(async (root, profiles) => {
    const previous = await readFile(join(root, "42.yaml"), "utf8");
    expect(await commands(profiles, () => false)()).toContain("无权注册");
    for (const patch of [{ message_type: "group" as const, privateCredentialSignal: undefined }, { message_type: "terminal" as const },
      { isDelegated: true }, { privateCredentialSignal: undefined }, { user_id: 0 }]) {
      expect(await commands(profiles, () => true)(event(patch))).toContain("自己的 QQ 会话");
    }
    expect(await readFile(join(root, "42.yaml"), "utf8")).toBe(previous);
    expect((await profiles.previewRedeemSettings("42", 1)).allowNewJournal).toBe(false);
  });
});

test("已授权的本人群内注册沿用可信scope，仍核验注册权限", async () => {
  await fixture(async (_root, profiles) => {
    const group = event({ message_type: "group", isGroup: true, isPrivate: false, group_id: 77 });
    expect(await commands(profiles, () => false)(group)).toContain("无权注册");
    expect((await profiles.previewRedeemSettings("42", 1)).allowNewJournal).toBe(false);
    expect(await commands(profiles, () => true)(group)).toContain("已开启");
    expect((await profiles.previewRedeemSettings("42", 1)).allowNewJournal).toBe(true);
  });
});

test("注册权限在落盘前撤销或私聊会话结束，不建立本地授权", async () => {
  await fixture(async (root, profiles) => {
    const previous = await readFile(join(root, "42.yaml"), "utf8");
    let checks = 0;
    expect(await commands(profiles, () => ++checks === 1)()).toContain("无法保存");
    const session = new AbortController();
    expect(await commands(profiles, () => { session.abort(); return true; })(event({ privateCredentialSignal: session.signal }))).toBeUndefined();
    expect(await readFile(join(root, "42.yaml"), "utf8")).toBe(previous);
  });
});
