import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageLegacyRedeemState } from "../lib/migration-redeem-state.ts";
import { createPreviewRedeemRunner } from "../lib/redeem-code-runner.ts";

const own = "data/redeemCodes";
const lotus = "plugins/Lotus-Plugin/data/redeemCodes";
const refactor = "plugins/Lotus-ReFactor/data/redeemCodes";
const marker = "__lotusPreviewJournalVersion";
const key = (value: string) => createHash("sha256").update(value).digest("hex");
const started = { time: 123, status: "started" };
const finished = { time: 234, status: "finished" };

async function runFixture(action: (source: string, stage: string) => void | Promise<void>) {
  const fixture = await mkdtemp(join(tmpdir(), "lotus-redeem-migration-test-"));
  try {
    const source = join(fixture, "source"), stage = join(fixture, "stage");
    await Promise.all([mkdir(source), mkdir(stage)]);
    await action(source, stage);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function write(root: string, name: string, data: unknown) {
  const file = join(root, name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data) + "\r\n");
  return file;
}

test("合并真实批次键，以未确认记录优先；与活动提示分别暂存", async () => runFixture(async (source, stage) => {
  const duplicate = key("同批次"), closed = key("已停止批次"), unknown = key("未确认批次");
  const prior = await write(source, own + "/auto.json", { [marker]: 1, [duplicate]: finished, [closed]: finished });
  await write(source, lotus + "/auto.json", { [duplicate]: started, [closed]: finished });
  await write(source, refactor + "/auto.json", { [duplicate]: finished, [unknown]: started });
  await write(source, own + "/activities.json", { gs: ["latest", "shared", "invalid id"] });
  await write(source, lotus + "/activities.json", { gs: ["shared", "older"], bh3: ["other"] });
  await write(source, refactor + "/activities.json", { gs: ["oldest"], sr: ["s1"], unsupported: ["do-not-use"] });
  const initial = await readFile(prior);
  expect(await stageLegacyRedeemState(source, stage)).toEqual({
    journal: { files: 3, entries: 3, pending: 2, duplicates: 3, conflicts: 2, authoritative: true },
    activities: { files: 3, games: 3, entries: 6 },
  });
  expect(await Bun.file(join(stage, own, "auto.json")).json()).toEqual({
    [duplicate]: started, [closed]: finished, [unknown]: started,
  });
  expect(await Bun.file(join(stage, own, "activities.json")).json()).toEqual({
    gs: ["latest", "shared", "older", "oldest"], bh3: ["other"], sr: ["s1"],
  });
  expect((await stat(join(stage, own, "auto.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(join(stage, own, "activities.json"))).mode & 0o777).toBe(0o600);
  expect(await readFile(prior)).toEqual(initial);
  await expect(stageLegacyRedeemState(source, stage)).rejects.toHaveProperty("code", "EEXIST");
}));

test("活动提示、空旧账本和带标记的新版记录不解除旧授权暂停", async () => runFixture(async (source, stage) => {
  await write(source, lotus + "/activities.json", { gs: Array.from({ length: 15 }, (_, index) => "event_" + index) });
  expect((await stageLegacyRedeemState(source, stage)).activities.entries).toBe(12);
  expect(await Bun.file(join(stage, own, "auto.json")).exists()).toBe(false);
  const other = join(dirname(stage), "other");
  await mkdir(other);
  await write(source, lotus + "/auto.json", {});
  await write(source, own + "/auto.json", { [marker]: 1, [key("new profile history")]: started });
  const result = await stageLegacyRedeemState(source, other);
  expect(result.journal).toMatchObject({ entries: 1, pending: 1, authoritative: false });
  expect(await Bun.file(join(other, own, "auto.json")).json()).toHaveProperty(marker, 1);
  const runner = createPreviewRedeemRunner({
    journal: join(other, own, "auto.json"),
    listProfiles: async () => [{ qq: "42", profileId: 1, games: ["gs"] }],
    lookup: async () => { throw new Error("旧授权未补证，不能进入查码链"); },
    readRoles: async () => { throw new Error("旧授权未补证，不能读取角色"); },
  });
  expect(await runner.hasHistory()).toBe(false);
  await runner.scan(undefined, message => { throw new Error(message); });
}));

test("主账本能拦截原隐式批次的待确认请求", async () => runFixture(async (source, stage) => {
  const implicit = key(JSON.stringify(["117", "gs", "7.2", "implicit"]));
  await write(source, refactor + "/auto.json", { [implicit]: started });
  await stageLegacyRedeemState(source, stage);
  let lookups = 0, reads = 0;
  const runner = createPreviewRedeemRunner({
    journal: join(stage, own, "auto.json"),
    now: () => 1001,
    listProfiles: async () => [{ qq: "42", profileId: 1, games: ["gs"] }],
    lookup: async () => {
      lookups++;
      return { game: "gs", version: "7.2", actId: "fixture_27", status: "available", startAt: 10, expiry: null,
        codes: [{ code: "FIXTUREA" }, { code: "FIXTUREB" }, { code: "FIXTUREC" }] };
    },
    readRoles: async () => {
      reads++;
      return { accountId: "117", selectedUid: "", roles: [{ uid: "118", region: "cn_gf01" }],
        submit: async () => { throw new Error("待确认批次不能重新提交"); } };
    },
    notify: async () => { throw new Error("待确认批次不能发送成功回执"); },
  });
  expect(await runner.hasHistory()).toBe(true);
  await runner.scan(undefined, message => { throw new Error(message); });
  expect([lookups, reads]).toEqual([1, 1]);
  expect(await Bun.file(join(stage, own, "auto.json")).json()).toEqual({ [implicit]: started });
}));

test("损坏、链接、重叠和取消的档案均不产生部分输出", async () => runFixture(async (source, stage) => {
  expect(await stageLegacyRedeemState(source, stage)).toEqual({
    journal: { files: 0, entries: 0, pending: 0, duplicates: 0, conflicts: 0, authoritative: false },
    activities: { files: 0, games: 0, entries: 0 },
  });
  const invalid = await write(source, lotus + "/auto.json", { [key("invalid")]: { status: "finished", time: "not-a-time" } });
  await write(source, lotus + "/activities.json", { gs: ["valid"] });
  await expect(stageLegacyRedeemState(source, stage)).rejects.toThrow(/无效记录/u);
  expect(await Bun.file(join(stage, own, "activities.json")).exists()).toBe(false);
  await rm(invalid);
  const regular = await write(source, own + "/auto.json", { [key("valid")]: started });
  await symlink(regular, invalid);
  await expect(stageLegacyRedeemState(source, stage)).rejects.toThrow(/无链接/u);
  await rm(invalid);
  await link(regular, invalid);
  await expect(stageLegacyRedeemState(source, stage)).rejects.toThrow(/无链接/u);
  await expect(stageLegacyRedeemState(source, source)).rejects.toThrow(/分离/u);
  await expect(stageLegacyRedeemState(source, stage, AbortSignal.abort(new Error("fixture cancelled")))).rejects.toThrow(/fixture cancelled/u);
  expect(await Bun.file(join(stage, own, "auto.json")).exists()).toBe(false);
}));
