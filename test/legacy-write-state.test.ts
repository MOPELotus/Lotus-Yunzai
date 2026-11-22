import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareLegacyCheckinSchedule } from "../lib/checkin-schedule-handback.ts";
import { checkinScheduleClock, generateCheckinSchedulePlan } from "../lib/checkin-schedule-plan.ts";
import { parseWriteStateJson, prepareLegacyShopWriteState } from "../lib/legacy-write-state.ts";

const holder = { qq: "10002", profileId: 1, accountId: "80001" };
const plan = (id: string, status: string, attempts = 0) => ({ id, ...holder, goodsId: "70001", status, attempts });
const ledger = (plans: object[], trackers: object[] = []) => ({ version: 2, plans, trackers });
const sha = (input: Uint8Array) => createHash("sha256").update(input).digest("hex");

test("旧商城活跃项、追踪和冲突终态无法直接再提交，已确认成功及旧独有账目保留", () => {
  const rule = { id: "rule", ...holder, enabled: true };
  const current = ledger([plan("submitted", "submitting", 1), plan("new", "scheduled"), plan("confirmed", "succeeded", 1),
    plan("disputed", "failed", 2), plan("priority", "scheduled", 1), plan("stale", "preparing", 1)], [rule]);
  const prior = ledger([plan("submitted", "scheduled"), plan("confirmed", "unknown", 1), plan("disputed", "succeeded", 2),
    plan("priority", "succeeded", 1), plan("stale", "succeeded", 0), plan("legacy", "cancelled")]);
  const result = prepareLegacyShopWriteState(current, prior);
  expect(result).toMatchObject({ kept: 3, held: 3, cancelled: 1, disabled: 1 });
  expect(result.data.plans.map(row => [row.id, row.status])).toEqual([
    ["submitted", "unknown"], ["new", "cancelled"], ["confirmed", "succeeded"], ["disputed", "unknown"],
    ["priority", "succeeded"], ["stale", "unknown"], ["legacy", "cancelled"],
  ]);
  expect(result.data.trackers[0]).toMatchObject({ id: rule.id, enabled: false });
  expect(rule.enabled).toBe(true);
  expect(current.plans[0]).toMatchObject({ status: "submitting", attempts: 1 });
});

test("账本拒绝同记录换绑和含转义的重复 JSON 字段", () => {
  expect(() => prepareLegacyShopWriteState(ledger([plan("order", "unknown")]),
    ledger([{ ...plan("order", "scheduled"), accountId: "80002" }]))).toThrow("不同账号或商品");
  expect(() => parseWriteStateJson(Buffer.from('{"status":"submitting","\\u0073tatus":"scheduled"}'))).toThrow("重复 JSON");
});

test("旧版仅识别通知完成位，曾尝试发送的提醒交还后不重发", async () => {
  const now = Date.parse("2026-11-22T14:00:00+08:00");
  const { date } = checkinScheduleClock(now);
  const source = generateCheckinSchedulePlan({ date, now, profiles: [{ qq: "10002", enabled: true }] });
  const legacy = { ...source, entries: [{ ...source.entries[0]!, noticeAttemptedAt: new Date(now).toISOString() }] };
  const result = await prepareLegacyCheckinSchedule(source, legacy, "e28c6df", { now });
  expect(result.plan.entries[0]).toMatchObject({ notified: true, done: false });
  expect(result.plan.entries[0]?.noticeAttemptedAt).toBeUndefined();
});

test("统一交还先预检、独立发布私有完整载荷，原件与其余目录保持不变", async () => {
  const base = await mkdtemp(join(tmpdir(), "lotus-legacy-write-state-"));
  try {
    const modern = join(base, "modern"), legacy = join(base, "legacy"), output = join(base, "exports");
    await Promise.all([mkdir(modern), mkdir(legacy), mkdir(output)]);
    const files = new Map<string, string>();
    async function source(root: string, path: string, data: object) {
      const file = join(root, path);
      const bytes = JSON.stringify(data);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
      files.set(file, bytes);
    }
    const redeem = "data/redeemCodes/auto.json", shop = "data/coinShop/plans.json";
    const oldKey = "a".repeat(64), newKey = "b".repeat(64);
    await source(legacy, redeem, { [oldKey]: { status: "finished", time: 1 } });
    await source(modern, redeem, { __lotusPreviewJournalVersion: 1, [newKey]: { status: "started", time: 2 } });
    await source(modern, shop, ledger([plan("order", "submitting", 1)], [{ id: "tracker", ...holder, enabled: true }]));
    await source(legacy, shop, ledger([plan("order", "scheduled")]));
    const now = Date.now(), { date } = checkinScheduleClock(now);
    const schedule = generateCheckinSchedulePlan({ date, now, profiles: [{ qq: "10002", enabled: true }] });
    const file = `data/schedules/${date}.json`;
    await source(modern, file, { ...schedule, entries: [{ ...schedule.entries[0]!, manualOnly: true }] });
    const cli = new URL("../scripts/prepare-legacy-write-state.ts", import.meta.url).pathname;
    async function run(args: string[] = []) {
      const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args, modern, legacy, "e28c6df"],
        { stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    }
    const dry = await run();
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ mode: "dry-run", redeem: { preserved: 1, added: 1 },
      shop: { held: 1, disabled: 1 }, schedules: [{ held: 1 }] });
    expect(await readdir(output)).toEqual([]);

    expect((await run(["--export", legacy])).code).toBe(1);
    const exported = await run(["--export", output]);
    expect(exported.code).toBe(0);
    const result = JSON.parse(exported.stdout);
    expect(await readdir(output)).toHaveLength(1);
    expect((await stat(result.path)).mode & 0o777).toBe(0o700);
    for (const path of [redeem, shop, file]) {
      const exportedFile = join(result.path, path);
      expect(sha(await readFile(exportedFile))).toBe(result.files[path].output);
      expect((await stat(exportedFile)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await readFile(join(result.path, redeem), "utf8"))).toEqual({
      [oldKey]: { status: "finished", time: 1 }, [newKey]: { status: "started", time: 2 },
    });
    expect(JSON.parse(await readFile(join(result.path, shop), "utf8"))).toMatchObject({
      plans: [{ status: "unknown" }], trackers: [{ enabled: false }],
    });
    expect(JSON.parse(await readFile(join(result.path, file), "utf8")).entries[0]).toMatchObject({ done: true, stage: "handoff-held" });
    for (const [path, bytes] of files) expect(await readFile(path, "utf8")).toBe(bytes);
    await writeFile(join(modern, file), '{"invalid":true}');
    expect((await run(["--export", output])).code).toBe(1);
    expect(await readdir(output)).toHaveLength(1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
