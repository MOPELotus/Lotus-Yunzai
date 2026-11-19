import { expect, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckinAudit, type CheckinAuditScope } from "../lib/checkin-audit.ts";

const qq = "42";
const timestamp = "2026-01-03T12:34:56.123+08:00";
const entry = { qq, profileId: 1, ok: true, stage: "checkin", source: "manual" } as const;

async function workspace(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-checkin-audit-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("旧 JSONL 按 QQ 取最新 12 条，跳过畸形、坏时间和中断行，旧原文不会返回", () => workspace(async (directory) => {
  const file = join(directory, "checkin.jsonl");
  const legacy = { ...entry, time: timestamp, message: "Cookie=synthetic-secret-from-upstream" };
  const rows = [
    ...Array.from({ length: 18 }, (_, index) => JSON.stringify({ ...legacy, profileId: index + 1 })),
    "{malformed", JSON.stringify({ ...legacy, profileId: 254, time: "2026-02-31T12:34:56.123+08:00" }),
    JSON.stringify({ ...legacy, profileId: 255, qq: "" }),
    "x".repeat(40 * 1024),
    JSON.stringify({ ...legacy, qq: "43", profileId: 22, stage: "schedule", source: "scheduled" }),
    JSON.stringify({ ...legacy, profileId: 99 }), // This last row has no completed line ending.
  ];
  await writeFile(file, rows.join("\r\n"));
  const audit = createCheckinAudit(file);
  const own = await audit.read({ qq });
  expect(own.map(({ profileId }) => profileId)).toEqual(Array.from({ length: 12 }, (_, index) => 18 - index));
  expect(own[0]).toMatchObject({ qq, time: timestamp, message: "签到已完成。" });
  expect(JSON.stringify(own)).not.toContain("synthetic-secret");
  const all = await audit.read({ owner: true });
  expect(all).toHaveLength(12);
  expect(all[0]).toMatchObject({ qq: "43", profileId: 22, message: "自动签到已处理。" });
  expect(await audit.read({ qq: "999" })).toEqual([]);
  for (const scope of [{}, { qq: "" }, { owner: false }, { owner: true, qq }]) {
    await expect(audit.read(scope as CheckinAuditScope)).rejects.toThrow("须指定");
  }
}));

test("新记录只保存结构化字段，追加时隔开旧半行，新目录为私有", () => workspace(async (directory) => {
  const nested = join(directory, "audit");
  const file = join(nested, "checkin.jsonl");
  const now = () => new Date("2026-01-03T04:34:56.123Z");
  const audit = createCheckinAudit(file, now);
  expect(await audit.read({ owner: true })).toEqual([]);
  await expect(lstat(nested)).rejects.toMatchObject({ code: "ENOENT" });
  await audit.append(entry);
  expect((await lstat(nested)).mode & 0o777).toBe(0o700);
  expect((await lstat(file)).mode & 0o777).toBe(0o600);
  const prior = await readFile(file, "utf8");
  await writeFile(file, prior + '{"half":"COOKIE=synthetic-old-secret');
  const input = { ...entry, ok: false, profileId: 2, counts: { signed: 3, failed: 1, unknown: "token" },
    message: "request with token=synthetic-raw-secret", token: "synthetic-raw-secret" };
  await audit.append(input);
  const bytes = await readFile(file, "utf8");
  expect(bytes).not.toContain("synthetic-raw-secret");
  expect(bytes).not.toContain('"unknown"');
  const rows = await audit.read({ qq });
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual({ ...entry, time: now().toISOString(), ok: false, profileId: 2,
    counts: { signed: 3, failed: 1 }, message: "签到有未完成的项目。签到成功 3、失败 1。" });
  expect(JSON.stringify(rows)).not.toContain("synthetic-old-secret");
  await expect(audit.append({ ...entry, counts: { signed: -1 } })).rejects.toThrow("记录无效");
}));

test("多个写者并发追加时，每条记录完整且各 QQ 不会相互串读", () => workspace(async (directory) => {
  const file = join(directory, "concurrent", "logs", "checkin.jsonl");
  const [first, second] = [createCheckinAudit(file), createCheckinAudit(file)];
  await Promise.all(Array.from({ length: 64 }, (_, index) => {
    const writer = index % 2 ? first : second;
    return writer.append({ ...entry, qq: index % 2 ? qq : "43", profileId: index + 1 });
  }));
  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  expect(lines).toHaveLength(64);
  expect(new Set(lines.map((line) => JSON.parse(line).profileId)).size).toBe(64);
  for (const id of [qq, "43"]) {
    const records = await first.read({ qq: id });
    expect(records.map(({ profileId }) => profileId)).toEqual(lines.map((line) => JSON.parse(line))
      .filter((row) => row.qq === id).slice(-12).reverse().map((row) => row.profileId));
  }
}));

test("拒绝越界目录、软链接和硬链接，日记不会改写外部文件", () => workspace(async (directory) => {
  const outside = join(directory, "outside");
  await mkdir(outside);
  const untouched = join(outside, "untouched");
  await writeFile(untouched, "leave this file alone");
  const symlinked = join(directory, "unsafe-dir");
  await symlink(outside, symlinked, "dir");
  for (const path of [join(symlinked, "new", "checkin.jsonl"), join(directory, "sym.jsonl"), join(directory, "hard.jsonl")]) {
    if (path.endsWith("sym.jsonl")) await symlink(untouched, path);
    if (path.endsWith("hard.jsonl")) await link(untouched, path);
    const audit = createCheckinAudit(path);
    await expect(audit.append(entry)).rejects.toThrow();
  }
  await expect(createCheckinAudit(join(directory, "sym.jsonl")).read({ owner: true })).rejects.toThrow();
  await expect(createCheckinAudit(join(symlinked, "untouched")).read({ owner: true })).rejects.toThrow();
  await expect(lstat(join(outside, "new"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(untouched, "utf8")).toBe("leave this file alone");
}));
