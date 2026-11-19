import { expect, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CheckinScheduleEntry, type CheckinSchedulePlan } from "../lib/checkin-schedule-plan.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";

const date = "2026-11-19";
const tomorrow = "2026-11-20";
const name = `${date}.json`;
const lock = `.${date}.lotus-checkin.sqlite`;
const stage = `.${date}.lotus-checkin.tmp`;
type Store = ReturnType<typeof createCheckinScheduleStore>;

function plan(entries: readonly CheckinScheduleEntry[] = [], day = date): CheckinSchedulePlan {
  return { version: 1, date: day, mode: "fixed", window: { window_start: "00:00", window_end: "23:30", notify_before: true },
    generatedAt: `${date}T00:00:00.000+08:00`, entries };
}

function entry(qq: string): CheckinScheduleEntry {
  return { qq, profileId: 1, name: "", time: "04:30", mode: "fixed", notified: false, done: false };
}

function fixture(run: (root: string, directory: string, store: Store) => Promise<void>) {
  return async () => {
    const root = await mkdtemp(join(tmpdir(), "lotus-checkin-plan-"));
    const directory = join(root, "data", "schedules");
    try {
      await run(root, directory, createCheckinScheduleStore(directory));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("缺文件便捷读取，日期严格绑定，空更新不重写版本一旧文件", fixture(async (_root, directory, store) => {
  expect(await store.read(date)).toBeUndefined();
  await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  for (const invalid of ["../2026-11-19", "2026-11-19\n", "2026-02-29", "0000-11-19", "2026-11-31"]) {
    await expect(store.read(invalid)).rejects.toThrow("日期无效");
    await expect(store.update(invalid, () => ({ result: false }))).rejects.toThrow("日期无效");
  }
  expect(await store.update(date, (current) => ({ result: current === undefined }))).toBe(true);
  expect(await store.read(date)).toBeUndefined();
  expect((await readdir(directory)).sort()).toEqual([lock]);

  const file = join(directory, name);
  const legacy = JSON.stringify({ ...plan(), entries: [{ qq: "42", time: "04:30", mode: "fixed" }], other: 99 });
  await writeFile(file, legacy);
  const stat = await lstat(file);
  expect(await store.read(date)).toEqual(plan([entry("42")]));
  expect(await store.update(date, (current) => ({ plan: current, result: current?.entries.length }))).toBe(1);
  expect(await readFile(file, "utf8")).toBe(legacy);
  expect((await lstat(file)).ino).toBe(stat.ino);
  await expect(store.update(date, () => ({ plan: plan([], tomorrow), result: false }))).rejects.toThrow("日期与文件不一致");
  expect(await readFile(file, "utf8")).toBe(legacy);
}));

test("同日并发更新在锁内合并，其他日期可独立写入", fixture(async (_root, directory, store) => {
  const secondStore = createCheckinScheduleStore(directory);
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = store.update(date, async (current) => {
    expect(current).toBeUndefined();
    locked.resolve();
    await release.promise;
    return { plan: plan([entry("42")]), result: "first" };
  });
  await locked.promise;
  let secondEntered = false;
  const second = secondStore.update(date, (current) => {
    secondEntered = true;
    expect(current?.entries.map((row) => row.qq)).toEqual(["42"]);
    return { plan: { ...current!, entries: [...current!.entries, entry("43")] }, result: "second" };
  });
  try {
    await secondStore.update(tomorrow, () => ({ plan: plan([entry("44")], tomorrow), result: undefined }));
    expect(secondEntered).toBe(false);
    expect(await secondStore.read(date)).toBeUndefined();
  } finally {
    release.resolve();
  }
  expect(await Promise.all([first, second])).toEqual(["first", "second"]);
  expect(await secondStore.read(date)).toEqual(plan([entry("42"), entry("43")]));
  expect(await store.read(tomorrow)).toEqual(plan([entry("44")], tomorrow));
  expect((await lstat(join(directory, name))).mode & 0o777).toBe(0o600);
}));

test("实际子进程在暂存完成、原子替换前被杀，旧计划可读取且下一写者可恢复", fixture(async (_root, directory, store) => {
  await store.update(date, () => ({ plan: plan([entry("42")]), result: undefined }));
  const file = join(directory, name);
  const before = await readFile(file, "utf8");
  const child = Bun.spawn([process.execPath, "--eval", `
    import { mock } from "bun:test";
    import * as fs from "node:fs/promises";
    mock.module("node:fs/promises", () => ({ ...fs, async rename() {
      console.log("staged");
      await Bun.sleep(30_000);
    } }));
    const { createCheckinScheduleStore } = await import(${JSON.stringify(join(import.meta.dir, "../lib/checkin-schedule-store.ts"))});
    await createCheckinScheduleStore(process.argv[1]).update(${JSON.stringify(date)},
      () => ({ plan: ${JSON.stringify(plan([entry("99")]))}, result: undefined }));
  `, directory], { stdout: "pipe", stderr: "pipe" });
  const stdout = child.stdout.getReader();
  const deadline = AbortSignal.timeout(3_000);
  try {
    const chunk = await Promise.race([stdout.read(), new Promise<never>((_, reject) => {
      deadline.addEventListener("abort", () => reject(new Error("未捕获暂存检查点。")), { once: true });
    })]);
    expect(new TextDecoder().decode(chunk.value)).toBe("staged\n");
    expect(await store.read(date)).toEqual(plan([entry("42")]));
    expect((await readFile(join(directory, stage), "utf8")).includes('"99"')).toBe(true);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    stdout.releaseLock();
  }
  expect(child.signalCode).toBe("SIGKILL");
  expect(await readFile(file, "utf8")).toBe(before);
  await store.update(date, (current) => ({ plan: { ...current!, entries: [...current!.entries, entry("43")] }, result: undefined }));
  expect(await store.read(date)).toEqual(plan([entry("42"), entry("43")]));
  expect((await readdir(directory)).sort()).toEqual([lock, name]);
  await link(file, join(directory, stage));
  expect(await store.read(date)).toEqual(plan([entry("42"), entry("43")]));
  expect(await store.update(date, () => ({ result: "recovered" }))).toBe("recovered");
  expect((await readdir(directory)).sort()).toEqual([lock, name]);
  expect((await lstat(file)).nlink).toBe(1);
}));

test("拒绝格式不明或日期不符的旧文件，保留回调途中出现的外部版本", fixture(async (_root, directory, store) => {
  await mkdir(directory, { recursive: true });
  const file = join(directory, name);
  for (const invalid of ["{broken", "null", JSON.stringify(plan([], tomorrow)), undefined]) {
    const raw = invalid === undefined ? Buffer.alloc(4 * 1024 * 1024 + 1, 0x61) : Buffer.from(invalid);
    await writeFile(file, raw);
    await expect(store.read(date)).rejects.toThrow();
    let entered = false;
    await expect(store.update(date, () => {
      entered = true;
      return { plan: plan(), result: undefined };
    })).rejects.toThrow();
    expect(entered).toBe(false);
    expect((await readFile(file)).equals(raw)).toBe(true);
  }
  await rm(file);
  const external = JSON.stringify(plan([entry("45")]));
  await expect(store.update(date, async () => {
    await writeFile(file, external, { flag: "wx" });
    return { plan: plan([entry("42")]), result: undefined };
  })).rejects.toThrow("其他进程修改");
  expect(await readFile(file, "utf8")).toBe(external);
  const changed = JSON.stringify(plan([entry("46")]));
  await expect(store.update(date, async (current) => {
    expect(current).toEqual(plan([entry("45")]));
    await writeFile(join(directory, "external.tmp"), changed);
    await rename(join(directory, "external.tmp"), file);
    return { plan: plan([entry("44")]), result: undefined };
  })).rejects.toThrow("其他进程修改");
  expect(await readFile(file, "utf8")).toBe(changed);
}));

test("路径、日期文件、临时文件及 SQLite 锁拒绝不受信链接", fixture(async (root, directory, store) => {
  await mkdir(dirname(directory), { recursive: true });
  const outside = join(root, "outside");
  const victim = join(outside, name);
  const original = JSON.stringify(plan([entry("99")]));
  await mkdir(outside);
  await writeFile(victim, original);
  await symlink(outside, directory);
  await expect(store.read(date)).rejects.toThrow("实际目录");
  await expect(store.update(date, () => ({ plan: plan(), result: undefined }))).rejects.toThrow("实际目录");
  await rm(directory);
  await mkdir(directory);
  for (const make of [symlink, link]) {
    const file = join(directory, name);
    await make(victim, file);
    await expect(store.read(date)).rejects.toThrow();
    await expect(store.update(date, () => ({ plan: plan(), result: undefined }))).rejects.toThrow();
    await rm(file);
  }
  for (const unsafe of [lock, `${lock}-journal`, stage]) {
    await rm(join(directory, unsafe), { force: true });
    await symlink(victim, join(directory, unsafe));
    await expect(store.update(date, () => ({ plan: plan(), result: undefined }))).rejects.toThrow();
    await rm(join(directory, unsafe));
  }
  expect(await readFile(victim, "utf8")).toBe(original);
  expect(await store.read(date)).toBeUndefined();
}));

test("执行锁跨进程拒绝同日竞争，允许短更新和其他日期，崩溃后可再次取得", fixture(async (_root, directory, store) => {
  const child = Bun.spawn([process.execPath, "--eval", `
    import { createCheckinScheduleStore } from ${JSON.stringify(join(import.meta.dir, "../lib/checkin-schedule-store.ts"))};
    await createCheckinScheduleStore(process.argv[1]).withExecutionLock(${JSON.stringify(date)}, async () => {
      console.log("running");
      await Bun.sleep(30_000);
    });
  `, directory], { stdout: "pipe", stderr: "pipe" });
  const stdout = child.stdout.getReader();
  const deadline = AbortSignal.timeout(3_000);
  try {
    const chunk = await Promise.race([stdout.read(), new Promise<never>((_, reject) => {
      deadline.addEventListener("abort", () => reject(new Error("子进程没有开始执行夹具。")), { once: true });
    })]);
    expect(new TextDecoder().decode(chunk.value)).toBe("running\n");
    let entered = false;
    expect(await store.withExecutionLock(date, () => { entered = true; })).toEqual({ acquired: false });
    expect(entered).toBe(false);
    expect(await store.withExecutionLock(tomorrow, () => 19)).toEqual({ acquired: true, value: 19 });
    await store.update(date, () => ({ plan: plan([entry("42")]), result: undefined }));
    expect(await store.read(date)).toEqual(plan([entry("42")]));
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    stdout.releaseLock();
  }
  expect(child.signalCode).toBe("SIGKILL");
  const failure = new Error("execution fixture failed");
  await expect(store.withExecutionLock(date, () => { throw failure; })).rejects.toBe(failure);
  expect(await store.withExecutionLock(date, () => "resumed")).toEqual({ acquired: true, value: "resumed" });
}));
