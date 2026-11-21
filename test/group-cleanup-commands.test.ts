import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "@lotus-yunzai/account";
import { groupCleanupCommands } from "../lib/group-cleanup-commands.ts";
import { resolveLotusGlobalConfig } from "../lib/lotus-global-config.ts";
import { stageLegacyGlobalConfig } from "../lib/migration-global-config.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

async function profile(directory: string, id: number, groups: readonly number[]) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, id === 1 ? "123.yaml" : `123-${id}.yaml`);
  const bytes = Bun.YAML.stringify({ user: { qq: "123" }, profile: { id, notify: { fallback_groups: groups } } });
  await writeFile(file, bytes);
  return { file, bytes };
}

async function audit(path: string) {
  return (await readFile(path, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function png(params: unknown) {
  const match = /base64:\/\/([A-Za-z0-9+/]+={0,2})/u.exec(JSON.stringify(params));
  if (!match?.[1]) throw new Error("未收到状态卡");
  return Uint8Array.fromBase64(match[1]);
}

test("original manual group cleanup routes through both native gateways and writes only private audit rows", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-legacy-cleanup-"));
  try {
    const profiles = join(temporary, "profiles");
    const legacyFiles = await Promise.all([profile(profiles, 1, [601, 602]), profile(profiles, 2, [602])]);
    const preload = `
Bun.env.LOTUS_PROFILE_DIR = ${JSON.stringify(profiles)};
`;
    await withDualGatewayFixture("manual-group-cleanup", "disablePrivate: false\nmaster:\n  - '99:42'\n  - '100:43'\n",
      async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
        sendOneBot("#群清理退群 123", { message_type: "group", sub_type: "normal", group_id: 601 });
        const group = await onebot.next("send_msg");
        expect(group.params).toMatchObject({ group_id: 601 });
        expect(await new Bun.Image(png(group.params)).metadata()).toMatchObject({ width: 2880, format: "png" });
        group.respond({ message_id: 6011 });

        await sendMilky("#群清理退群 123 602");
        const direct = await milky.next("send_private_message");
        expect(direct.params).toMatchObject({ user_id: 43, message: [{ type: "image" }] });
        direct.respond({ message_seq: 6021 });

        sendOneBot("#群清理退群 123 602", { user_id: 51 });
        const denied = await onebot.next("send_msg");
        denied.respond({ message_id: 6013 });

        const file = join(root, "data", "audit", "group-cleanup.jsonl");
        const rows = await audit(file);
        expect(rows.map(row => [row.groupId, row.dryRun, row.actions.map((a: { removedFallback: boolean }) => a.removedFallback)]))
          .toEqual([["601", true, [true, false]], ["602", true, [true, true]]]);
        expect((await Bun.file(file).stat()).mode & 0o777).toBe(0o600);
        for (const { file: path, bytes } of legacyFiles) expect(await readFile(path, "utf8")).toBe(bytes);
      }, 8500, preload);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}, 30_000);

test("allow, deny, missing group and invalid IDs retain the preview boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-legacy-cleanup-unit-"));
  try {
    const slot = await profile(join(root, "profiles"), 1, [601]);
    const path = join(root, "group-cleanup.jsonl");
    let configured: Record<string, unknown> = {
      groups: { cleanup: { enable: false, dry_run: false, delete_orphan_profiles: true } },
      permissions: { scopes: { "group.cleanup": { policy: "allow" } } },
    };
    const run = groupCleanupCommands({
      readConfig: async () => configured, profiles: createProfileStore(join(root, "profiles")),
      auditPath: path, isMaster: () => false, activeSignal: signal => signal,
      render: async () => { throw new Error("fixture uses textual reply"); },
    }).commands["#群清理退群"]!;
    const context = { message_type: "private", user_id: 42, self_id: 99, isMaster: true, privateCredentialSignal: new AbortController().signal } as const;
    expect(await run("123", context)).toMatch(/预览[\s\S]*归档仅预览[\s\S]*群　未知[\s\S]*拟移除群通知回退　0/u);
    expect(await run("123 601", context)).toMatch(/拟移除群通知回退　1/u);
    expect(await run("123 9999999999999999", context)).toMatch(/请使用/u);
    expect(await run("123 601", { ...context, isDelegated: true })).toMatch(/没有群配置清理权限/u);
    configured = { ...configured, permissions: { users: { deny: [42] }, scopes: { "group.cleanup": { policy: "allow" } } } };
    expect(await run("123 601", context)).toMatch(/没有群配置清理权限/u);
    configured = {};
    expect(await run("123 601", context)).toMatch(/没有群配置清理权限/u);
    expect(await audit(path)).toHaveLength(2);
    expect(await readFile(slot.file, "utf8")).toBe(slot.bytes);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("migration preserves the legacy cleanup fields, effective scoped permission and local overrides", async () => {
  const read = async () => ({ groups: { unrelated: true, cleanup: { dry_run: false } } });
  expect((await resolveLotusGlobalConfig({}, read)).groups).toEqual({ cleanup: { dry_run: false } });
  expect((await resolveLotusGlobalConfig({ groups: { cleanup: null } }, read)).groups).toEqual({ cleanup: null });
  const root = await mkdtemp(join(tmpdir(), "lotus-legacy-cleanup-migration-"));
  try {
    const old = join(root, "old");
    const legacy = join(old, "plugins", "Lotus-ReFactor", "config");
    const local = join(old, "config");
    const stage = join(root, "stage");
    const otherLegacy = join(old, "plugins", "Lotus-Plugin", "config");
    await Promise.all([legacy, otherLegacy, local, stage].map(dir => mkdir(dir, { recursive: true })));
    await writeFile(join(otherLegacy, "global.yaml"), "groups:\n  unrelated: true\n");
    await writeFile(join(legacy, "global.yaml"), Bun.YAML.stringify({
      groups: { cleanup: { enable: false, dry_run: true, remove_group_fallback: false,
        delete_orphan_profiles: true, keep_if_private_possible: false, unknown: 123 } },
      permissions: { scopes: { "group.cleanup": { policy: "master_only" } } },
    }));
    await writeFile(join(local, "global.yaml"), "groups:\n  cleanup:\n    dry_run: false\n");
    const result = await stageLegacyGlobalConfig(old, stage);
    expect(result.sections).toContain("groups");
    expect(Bun.YAML.parse(await readFile(join(stage, "config", "global.yaml"), "utf8"))).toEqual({
      groups: { cleanup: { enable: false, dry_run: false, remove_group_fallback: false,
        delete_orphan_profiles: true, keep_if_private_possible: false } },
      permissions: { scopes: { "group.cleanup": { policy: "master_only" } } },
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("explicit apply removes only a confirmed departed member's fallback in either native group", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-legacy-cleanup-apply-"));
  try {
    const profiles = join(root, "profiles");
    const original = await profile(profiles, 1, [601, 602, 603, 601]);
    const separate = await profile(profiles, 2, [605]);
    const preload = `Bun.env.LOTUS_PROFILE_DIR = ${JSON.stringify(profiles)};`;
    const member = (group: number, user: number, role = "member") => ({
      group_id: group, user_id: user, role, join_time: 10, last_sent_time: 0,
    });
    const current = async () => {
      const saved = Bun.YAML.parse(await readFile(original.file, "utf8")) as { profile: { notify: { fallback_groups: number[] } } };
      return saved.profile.notify.fallback_groups;
    };
    await withDualGatewayFixture("apply-group-cleanup", "disablePrivate: false\nmaster:\n  - '99:42'\n  - '100:43'\n",
      async ({ root: host, onebot, milky, sendOneBot, sendMilky }) => {
        sendOneBot("#群清理退群 123", { message_type: "group", sub_type: "normal", group_id: 601 });
        let action = await onebot.next("get_group_info");
        expect(action.params).toEqual({ group_id: 601, no_cache: true });
        action.respond({ group_id: 601, member_count: 2 });
        action = await onebot.next("get_group_member_list");
        expect(action.params).toEqual({ group_id: 601, no_cache: true });
        action.respond([member(601, 99), member(601, 42, "owner")]);
        (await onebot.next("get_group_info")).respond({ group_id: 601, member_count: 2 });
        (await onebot.next("send_msg")).respond({ message_id: 6019 });
        expect(await current()).toEqual([602, 603]);

        await sendMilky("#群清理退群 123 602", { message_scene: "group", peer_id: 602 });
        action = await milky.next("get_group_info");
        expect(action.params).toEqual({ group_id: 602, no_cache: true });
        action.respond({ group: { group_id: 602, member_count: 2 } });
        action = await milky.next("get_group_member_list");
        expect(action.params).toEqual({ group_id: 602, no_cache: true });
        action.respond({ members: [member(602, 100), member(602, 43, "owner")] });
        (await milky.next("get_group_info")).respond({ group: { group_id: 602, member_count: 2 } });
        (await milky.next("send_group_message")).respond({ message_seq: 6029 });
        expect(await current()).toEqual([603]);

        await sendMilky("#群清理退群 123", { message_scene: "group", peer_id: 603 });
        (await milky.next("get_group_info")).respond({ group: { group_id: 603, member_count: 3 } });
        (await milky.next("get_group_member_list")).respond({ members: [member(603, 100), member(603, 43, "owner")] });
        (await milky.next("get_group_info")).respond({ group: { group_id: 603, member_count: 3 } });
        (await milky.next("send_group_message")).respond({ message_seq: 6039 });
        expect(await current()).toEqual([603]);
        expect(await readFile(separate.file, "utf8")).toBe(separate.bytes);
        const rows = await audit(join(host, "data", "audit", "group-cleanup.jsonl"));
        expect(rows.map(row => [row.groupId, row.phase, row.dryRun])).toEqual([
          ["601", "plan", true], ["601", "result", false], ["602", "plan", true],
          ["602", "result", false], ["603", "plan", true], ["603", "result", true],
        ]);
      }, 8500, preload, async host => {
        await writeFile(join(host, "config", "global.yaml"), "groups:\n  cleanup:\n    enable: false\n    dry_run: false\n");
      });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

test("late policy denial, revoked session and compare-and-swap protect the same profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-legacy-cleanup-authority-"));
  try {
    const stored = await profile(root, 1, [601, 602]);
    const path = join(root, "group-cleanup.jsonl");
    const store = createProfileStore(root);
    const session = new AbortController();
    const initialConfig = { groups: { cleanup: { dry_run: false } } };
    let configured: Record<string, unknown> = initialConfig;
    const deny = { permissions: { scopes: { "group.cleanup": { policy: "deny" } } } };
    const context = { message_type: "group", user_id: 42, self_id: 99, group_id: 601, isMaster: true,
      groupActivitySignal: session.signal } as const;
    const options = {
      readConfig: async () => configured, profiles: store, auditPath: path, isMaster: () => true,
      activeSignal: (signal: AbortSignal) => signal,
      render: async () => { throw new Error("fixture uses textual reply"); },
    };
    const run = groupCleanupCommands(options).commands["#群清理退群"]!;
    const { revision } = await store.checkinSettings("123", 1);
    expect(await run("123", { ...context, async groupActivityRoster() { configured = deny; return []; } })).toMatch(/没有群配置清理权限/u);
    expect(await readFile(stored.file, "utf8")).toBe(stored.bytes);

    configured = initialConfig;
    const revokeInRender = groupCleanupCommands({ ...options, async render() {
      configured = deny;
      throw new Error("fixture uses textual reply");
    } }).commands["#群清理退群"]!;
    expect(await revokeInRender("123 602", context)).toMatch(/没有群配置清理权限/u);
    configured = initialConfig;
    const revokeInRead = groupCleanupCommands({ ...options, profiles: { ...store, async listIds() {
      session.abort();
      return [1];
    } } }).commands["#群清理退群"]!;
    expect(await revokeInRead("123", context)).toBe("");
    expect(await readFile(stored.file, "utf8")).toBe(stored.bytes);

    const tools = new AbortController();
    const firstLock = Promise.withResolvers<void>();
    const continueWrite = Promise.withResolvers<void>();
    const competing = store.removeGroupCheckinFallback("123", 1, revision, 601, tools.signal, async () => {
      firstLock.resolve();
      await continueWrite.promise;
    });
    await Promise.race([firstLock.promise, competing]);
    const stale = store.removeGroupCheckinFallback("123", 1, revision, 602, tools.signal, async () => {});
    const staleResult = stale.then(value => ({ value }), (error: unknown) => ({ error }));
    continueWrite.resolve();
    expect((await competing).changed).toBe(true);
    expect(await staleResult).toMatchObject({ error: { code: "changed" } });
    expect((await store.checkinSettings("123", 1)).notify.fallbackGroups).toEqual([602]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
