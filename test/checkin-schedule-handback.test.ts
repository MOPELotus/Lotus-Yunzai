import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProfileAccountContext } from "@lotus-yunzai/account";
import { prepareLegacyCheckinSchedule } from "../lib/checkin-schedule-handback.ts";
import { checkinScheduleClock, generateCheckinSchedulePlan } from "../lib/checkin-schedule-plan.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";

const now = Date.parse("2026-11-21T23:50:00+08:00");
const { date } = checkinScheduleClock(now);
const accounts = ["10001", "10002", "10003", "10004", "10005", "10006"];
function accountKey(qq: string) {
  return createHash("sha256").update(JSON.stringify([qq, 1, "80001"])).digest("hex");
}
function planFor(at = now) {
  const plan = generateCheckinSchedulePlan({ date: checkinScheduleClock(at).date, now: at,
    profiles: accounts.map(qq => ({ qq, enabled: true })) });
  const [mixed, game, done, unknown, rebound, untouched] = plan.entries;
  const retry = (qq: string) => ({ attempts: 0, nextAt: new Date(at).toISOString(), verifiedUnsent: true, accountKey: accountKey(qq) } as const);
  return { ...plan, entries: [
    { ...mixed!, communityRetry: { ...retry(mixed!.qq), forums: ["2", "6"], games: ["honkai_sr"] as const },
      communityWrites: { "2": "unconfirmed", "6": "retryable" } as const },
    { ...game!, communityRetry: { ...retry(game!.qq), forums: [], games: ["zzz"] as const } },
    { ...done!, done: true, ok: true },
    { ...unknown!, runningAt: new Date(at - 60_000).toISOString(), communityWrites: { "4": "pending" } as const },
    { ...rebound!, communityRetry: { ...retry(rebound!.qq), forums: ["8"] } },
    untouched!,
  ] };
}
const readAccount = async (qq: string, profileId: number) => ({
  qq, profileId, account: { stuid: qq === "10005" ? "80002" : "80001", ltuid: "", mid: "" },
} as ProfileAccountContext);

test("旧端无复核时仅投影完成与未领取项目，保持源补跑和未知写入", async () => {
  const source = planFor();
  const before = JSON.stringify(source);
  const { plan, counts } = await prepareLegacyCheckinSchedule(source, undefined, "5aa3a70", { now });
  expect(counts).toEqual({ completed: 1, unstarted: 1, held: 4, heldRetries: 3, unsupportedGames: 0, pendingGames: 0, pendingForums: 0 });
  expect(plan.entries.map(entry => [entry.qq, entry.done, entry.stage])).toEqual([
    ["10001", true, "handoff-held"], ["10002", true, "handoff-held"], ["10003", true, undefined],
    ["10004", true, "handoff-held"], ["10005", true, "handoff-held"], ["10006", false, undefined],
  ]);
  expect(plan.entries.some(entry => entry.communityRetry || entry.runningAt || entry.communityWrites)).toBe(false);
  expect(JSON.stringify(source)).toBe(before);
});

test("仅实际执行方可移交核实的队列，旧版按支持能力筛选，误投和未确认写入都被排除", async () => {
  const source = planFor();
  const verified = await prepareLegacyCheckinSchedule(source, undefined, "5aa3a70", { now, accountAtExecution: readAccount });
  expect(verified.counts).toMatchObject({ held: 2, pendingForums: 1, pendingGames: 2 });
  expect(verified.plan.entries[0]?.communityRetry).toMatchObject({ forums: ["6"], games: ["honkai_sr"], otherFailure: true });
  expect(verified.plan.entries[1]?.communityRetry).toMatchObject({ forums: [], games: ["zzz"] });
  expect(verified.plan.entries[3]).toMatchObject({ done: true, stage: "handoff-held" });
  expect(verified.plan.entries[4]).toMatchObject({ done: true, stage: "handoff-held" });
  const older = await prepareLegacyCheckinSchedule(source, undefined, "e28c6df", { now, accountAtExecution: readAccount });
  expect(older.counts).toMatchObject({ held: 4, heldRetries: 3, unsupportedGames: 2, pendingGames: 0, pendingForums: 0 });
  expect(older.plan.entries[0]).toMatchObject({ done: true, ok: false, stage: "handoff-held" });
  expect(older.plan.entries[1]).toMatchObject({ done: true, ok: false, stage: "handoff-held" });
  const forumOnly = { ...source.entries[0]!, communityRetry: { ...source.entries[0]!.communityRetry!, games: undefined } };
  const olderForum = await prepareLegacyCheckinSchedule({ ...source, entries: [forumOnly] }, undefined, "e28c6df",
    { now, accountAtExecution: readAccount });
  expect(olderForum.plan.entries[0]?.communityRetry).toMatchObject({ forums: ["6"], otherFailure: true });
  const next = await prepareLegacyCheckinSchedule(source, undefined, "5aa3a70", { now: now + 86_400_000, accountAtExecution: readAccount });
  expect(next.counts).toMatchObject({ pendingGames: 0, pendingForums: 0, unstarted: 0 });
});

test("旧副本已完成的档案不重开，旧副本中未确认的普通档不降成未领取", async () => {
  const source = planFor();
  const prior = { ...source, entries: [
    { ...source.entries[0]!, done: true, ok: true },
    { ...source.entries[5]!, communityWrites: { "6": "pending" } as const },
  ] };
  const result = await prepareLegacyCheckinSchedule(source, prior, "5aa3a70", { now, accountAtExecution: readAccount });
  expect(result.plan.entries[0]).toMatchObject({ done: true, ok: true });
  expect(result.plan.entries[0]?.communityRetry).toBeUndefined();
  expect(result.plan.entries[5]).toMatchObject({ done: true, ok: false, stage: "handoff-held" });
});

test("旧接收方只拿到无游戏写账的范围，保留同档其他社区目标", async () => {
  const source = planFor();
  const entry = source.entries[0]!;
  const key = `honkai_sr:cn:${"0".repeat(64)}`;
  const result = await prepareLegacyCheckinSchedule({ ...source, entries: [
    { ...entry, gameWrites: { [key]: "unconfirmed" }, gameWriteAccount: accountKey(entry.qq) },
  ] }, undefined, "5aa3a70", { now, accountAtExecution: readAccount });
  expect(result.counts).toMatchObject({ pendingForums: 1, pendingGames: 0 });
  expect(result.plan.entries[0]?.communityRetry).toMatchObject({ forums: ["6"], otherFailure: true });
  expect(result.plan.entries[0]?.communityRetry?.games).toBeUndefined();
  expect(result.plan.entries[0]?.gameWrites).toBeUndefined();
});

test("签到交还 CLI 默认只读，明确导出时写独立私有文件并保留原版守卫提示", async () => {
  const base = await mkdtemp(join(tmpdir(), "lotus-handback-test-"));
  try {
    const modern = join(base, "modern");
    const legacy = join(base, "legacy");
    const output = join(base, "exports");
    await Promise.all([mkdir(modern), mkdir(legacy), mkdir(output)]);
    const source = JSON.stringify(planFor());
    const file = join(modern, date + ".json");
    await writeFile(file, source);
    async function run(flags: string[] = []) {
      const cli = new URL("../scripts/prepare-legacy-checkin-schedule.ts", import.meta.url);
      const process = Bun.spawn([Bun.argv[0]!, cli.pathname, ...flags, modern, legacy, "e28c6df", date], {
        stdout: "pipe", stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
      return { exit, stdout, stderr };
    }
    const check = await run();
    expect(check.exit).toBe(0);
    expect(JSON.parse(check.stdout)).toMatchObject({ mode: "dry-run", written: false, heldRetries: 3, unsupportedGames: 2 });
    expect(check.stdout).toContain("核验接收版本及账户守卫");
    expect(await readdir(output)).toEqual([]);
    const exported = await run(["--export", output]);
    expect(exported.exit).toBe(0);
    const { path, written } = JSON.parse(exported.stdout);
    expect(written).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8")).entries[0]).toMatchObject({ done: true, stage: "handoff-held" });
    expect(await readFile(file, "utf8")).toBe(source);
    expect(await readdir(legacy)).toEqual([]);
    expect((await run(["--export", legacy])).exit).toBe(1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("重新接管时，暂缓旧端执行的标记不能覆盖现用原件已核实的未运行补跑", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-handback-return-"));
  try {
    const old = join(directory, "legacy");
    const modern = join(directory, "modern");
    const source = planFor();
    const { plan } = await prepareLegacyCheckinSchedule(source, undefined, "e28c6df", { now });
    await Promise.all([mkdir(old), mkdir(modern)]);
    await writeFile(join(old, date + ".json"), JSON.stringify(plan));
    await writeFile(join(modern, date + ".json"), JSON.stringify(source));
    const store = createCheckinScheduleStore(modern, [{ id: "old-handoff-fixture", directory: old }]);
    const recovered = await store.read(date);
    expect(recovered?.entries[0]?.communityRetry).toEqual(source.entries[0]?.communityRetry);
    expect(recovered?.entries[1]?.communityRetry).toEqual(source.entries[1]?.communityRetry);
    expect(recovered?.entries[3]).toMatchObject({ done: true, stage: "handoff-held" });
    const oldOnly = await createCheckinScheduleStore(old).read(date);
    expect(oldOnly?.entries[1]).toMatchObject({ done: true, stage: "handoff-held" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
