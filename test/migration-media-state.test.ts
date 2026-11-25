import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageLegacyMediaState } from "../lib/migration-media-state.ts";
import { BilibiliService } from "../plugins/media/services/bilibili/service.ts";
import { readMusicAccounts } from "../plugins/media/services/music/accounts.ts";
import { NeteasePartnerAccounts } from "../plugins/media/services/music/partner-account.ts";
import { NeteasePartnerTask } from "../plugins/media/services/music/partner-task.ts";
import { createSubscriptionConfig } from "../plugins/media/services/subscriptions/config.ts";
import { readBiliLocal } from "../plugins/media/services/subscriptions/session.ts";
import { TuneWeaveService } from "../plugins/media/services/tuneweave/service.ts";

async function put(root: string, name: string, bytes: string) {
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

async function fixture(action: (source: string, stage: string) => Promise<void>) {
  const temp = await mkdtemp(join(tmpdir(), "lotus-media-migration-"));
  try {
    const source = join(temp, "old");
    const stage = join(temp, "stage");
    await Promise.all([mkdir(source), mkdir(stage, { mode: 0o700 })]);
    await action(source, stage);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const oldRoot = "plugins/Lotus-ReFactor";
const account = "data/bilibili/account.yaml";
const music = "data/music/accounts.yaml";
const netease = "data/netease/accounts.yaml";
const neteaseState = "data/netease/state.yaml";
const yukiCookie = "data/yuki-plugin/biliCookie.yaml";
const yukiRoutes = "data/yuki-plugin/config/bilibili/push.guoba.support.yaml";
const managed = "data/tuneweave/accounts/accounts/bilibili/66697874757265/1.json";

test("uses TuneWeave's original address to decide whether its private account tree belongs to a local service", async () => {
  const root = "http://127.0.0.1:7832/";
  const doubleSlash = root + "/";
  for (const [previous, current, active] of [
    [root, root, true],
    [root, doubleSlash, false],
    [doubleSlash, root, false],
    [doubleSlash, doubleSlash, false],
  ] as const) {
    await fixture(async (source, stage) => {
      if (current === root) expect(new TuneWeaveService({ config: { api_url: current } }).localUrl().href).toBe(root);
      else expect(() => new TuneWeaveService({ config: { api_url: current } }).localUrl()).toThrow("远程 TuneWeave");
      await put(source, join(oldRoot, "config/global.yaml"), Bun.YAML.stringify({ tuneweave: { api_url: previous } }));
      await put(source, join(oldRoot, account), "tuneweave_account: fixture-alias\n");
      await put(source, join(oldRoot, managed), "{}\n");
      const result = await stageLegacyMediaState(source, stage, { tuneweaveUrl: current });
      const store = "data/tuneweave/accounts";
      expect(result.active).toEqual([{ path: account, files: 1 }, ...(active ? [{ path: store, files: 1 }] : [])]);
      expect(result.held).toEqual(active ? [] : [{ path: store, files: 1, reason: "endpoint" }]);
      expect(await Bun.file(join(stage, managed)).exists()).toBe(active);
      if (!active) expect(await readFile(join(stage, "backup/media-state", oldRoot, managed), "utf8")).toBe("{}\n");
    });
  }
});

test("stages old media bytes exactly at current runtime reader paths without invoking services", () => fixture(async (source, stage) => {
  const copies = {
    [account]: "tuneweave_account: local-fixture\nsource: isolated-qr\n",
    [music]: "accounts: {qq: {alias: demo, uid: '12'}}\n",
    [netease]: "accounts: [{uid: '34', comment: false, tuneweave_account: demo}]\n",
    [neteaseState]: "last_run_date: '2026-11-21'\nevaluation_receipts: [['34:1', pending]]\n",
    [managed]: '{"identity":"fixture"}\n',
  };
  for (const [name, body] of Object.entries(copies)) await put(source, join(oldRoot, name), body);
  const legacyCookie = "'SESSDATA=fixture; bili_jct=fixture; bili_ticket_expires=2147483647'\n";
  await put(source, yukiCookie, legacyCookie);
  await put(source, "data/yuki-plugin/config/bilibili/push.yaml", "group: {'77': [{bot_id: '90', uid: '123'}]}\n");
  await put(source, yukiRoutes, "# preserve old provider override\nprivate: {'42': [{bot_id: '90', uid: '456'}]}\n");
  const result = await stageLegacyMediaState(source, stage);
  expect(result.held).toEqual([]);
  expect(result.active).toHaveLength(8);
  for (const [name, body] of Object.entries(copies)) {
    expect(await readFile(join(stage, name), "utf8")).toBe(body);
    expect(await readFile(join(source, oldRoot, name), "utf8")).toBe(body);
    expect((await lstat(join(stage, name))).mode & 0o777).toBe(0o600);
  }
  const service = new BilibiliService({ accountFile: join(stage, account), fetch: async () => { throw new Error("network unavailable"); } });
  expect((await service.loadAccount())?.tuneweave_account).toBe("local-fixture");
  expect((await readMusicAccounts(join(stage, music))).qq?.uid).toBe("12");
  expect((await new NeteasePartnerAccounts(join(stage, netease)).loadAccounts())[0]?.comment).toBe(false);
  expect((await new NeteasePartnerTask({ stateFile: join(stage, neteaseState) }).state()).evaluation_receipts).toEqual([["34:1", "pending"]]);
  expect((await readBiliLocal(join(stage, "data")))?.fields.get("bili_ticket_expires")).toBe("2147483647");
  expect(await readFile(join(stage, yukiCookie), "utf8")).toBe(legacyCookie);
  expect(await readFile(join(stage, yukiRoutes), "utf8")).toContain("override");
  const yuki = createSubscriptionConfig(join(stage, "data"), async () => { throw new Error("read-only fixture"); });
  expect(await yuki.routes("bilibili")).toEqual([expect.objectContaining({ kind: "private", uid: "456" })]);
}));

test("holds provider credentials for a different endpoint and preserves current root overrides", () => fixture(async (source, stage) => {
  await put(source, join(oldRoot, "config/global.yaml"), "tuneweave: {api_url: 'http://127.0.0.1:7832'}\n");
  await put(source, join(oldRoot, account), "tuneweave_account: old-alias\n");
  await put(source, join(oldRoot, music), "accounts: {qq: {alias: old-alias}}\n");
  await put(source, account, "cookie: 'SESSDATA=current'\n");
  await put(source, join(oldRoot, managed), '{"identity":"local-only"}\n');
  const result = await stageLegacyMediaState(source, stage, { tuneweaveUrl: "https://other.example" });
  expect(result.active).toEqual([{ path: account, files: 1 }]);
  expect(result.held).toEqual([
    { path: music, files: 1, reason: "endpoint" },
    { path: "data/tuneweave/accounts", files: 1, reason: "endpoint" },
  ]);
  expect(await Bun.file(join(stage, music)).exists()).toBe(false);
  expect(await readFile(join(stage, "backup/media-state", oldRoot, managed), "utf8")).toContain("local-only");
}));

test("conflicting old copies remain private and links cannot activate or escape", () => fixture(async (source, stage) => {
  await put(source, join(oldRoot, account), "tuneweave_account: second\n");
  await put(source, join("plugins/Lotus-Plugin", account), "tuneweave_account: first\n");
  const result = await stageLegacyMediaState(source, stage);
  expect(result.held).toEqual([{ path: account, files: 2, reason: "conflict" }]);
  expect(await Bun.file(join(stage, account)).exists()).toBe(false);
  await mkdir(join(source, "data/yuki-plugin"), { recursive: true });
  await symlink(join(source, oldRoot, account), join(source, yukiCookie));
  await expect(stageLegacyMediaState(source, stage)).rejects.toThrow();
}));

test("duplicate old NetEase identities cannot become two active scheduled entries", () => fixture(async (source, stage) => {
  const duplicate = "accounts: [{uid: '34', tuneweave_account: one}, {uid: 34, tuneweave_account: two}]\n";
  await put(source, join(oldRoot, netease), duplicate);
  expect(await stageLegacyMediaState(source, stage)).toEqual({
    active: [], held: [{ path: netease, files: 1, reason: "format" }],
  });
  expect(await readFile(join(stage, "backup/media-state", oldRoot, netease), "utf8")).toBe(duplicate);
}));

for (const plugin of ["Lotus-Plugin", "Lotus-ReFactor"]) {
  test(`${plugin} 的 TuneWeave 空锁文件不应阻止六份凭据与设备资料迁移`, () => fixture(async (source, stage) => {
    const prefix = `plugins/${plugin}`;
    const store = "data/tuneweave/accounts";
    const lock = `${store}/accounts/.credential-store.lock`;
    await put(source, join(prefix, "config/global.yaml"), "tuneweave: {api_url: 'http://127.0.0.1:7832'}\n");
    const files = ["device.json", "kugou-device.json", ...["bilibili", "netease", "qq", "kugou"].map(provider =>
      `accounts/${provider}/66697874757265/1.json`)];
    for (const [index, file] of files.entries()) await put(source, join(prefix, store, file), JSON.stringify({ version: 1, credential: `fixture-${index}` }));
    await put(source, join(prefix, lock), "");
    const result = await stageLegacyMediaState(source, stage, { tuneweaveUrl: "http://127.0.0.1:7832" });
    expect(result).toEqual({ active: [{ path: store, files: 6 }], held: [] });
    for (const file of files) {
      expect(await readFile(join(stage, store, file))).toEqual(await readFile(join(source, prefix, store, file)));
      expect((await lstat(join(stage, store, file))).mode & 0o777).toBe(0o600);
    }
    expect(await Bun.file(join(stage, lock)).exists()).toBe(false);
    expect(await readFile(join(stage, "backup/media-state", prefix, lock), "utf8")).toBe("");
    expect(await readFile(join(source, prefix, lock), "utf8")).toBe("");
  }));
}

test("未知或非空的 TuneWeave 锁文件仍应私有保留并标记待处理", () => fixture(async (source, stage) => {
  await put(source, join(oldRoot, managed), "{}\n");
  await put(source, join(oldRoot, "data/tuneweave/accounts/accounts/.credential-store.lock"), "unexpected");
  const result = await stageLegacyMediaState(source, stage);
  expect(result.held).toEqual([{ path: "data/tuneweave/accounts", files: 2, reason: "format" }]);
  expect(await Bun.file(join(stage, managed)).exists()).toBe(false);
}));
