import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAppliedUpdateReports, appliedUpdateLogNodes, describeAppliedUpdates, reportCurrentUpdate } from "../lib/update-report.ts";
import { seedUpdateSubmodules } from "../lib/update-submodules.ts";
import { checkoutUpdateRevision } from "../lib/update-checkout.ts";
import { initializeUpdateSubmodules } from "../lib/update-build.ts";
import { createProcessReceipts } from "../lib/process-receipts.ts";
import { pathToFileURL } from "node:url";
import { isManagedUpdateProgress, isTerminalManagedUpdateProgress, type ManagedUpdateProgress } from "../lib/managed-update-protocol.ts";

function git(directory: string, ...args: string[]) {
  const run = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", ...args], {
    cwd: directory, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (run.exitCode) throw new Error(run.stderr.toString());
  return run.stdout.toString().trimEnd();
}
async function commit(directory: string, text: string) {
  await writeFile(join(directory, "value"), text);
  git(directory, "add", "."); git(directory, "commit", "-qm", text);
  return git(directory, "rev-parse", "HEAD");
}

test("更新报告包含主仓、变化的子模块的本次日志，跨进程保留，未变化仓库不混入", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-trss-report-"));
  try {
    const source = join(temporary, "source"), module = join(temporary, "module"), next = join(temporary, "next");
    await mkdir(source); await mkdir(module);
    git(module, "init", "-q"); const oldModule = await commit(module, "module baseline");
    git(source, "init", "-q"); await commit(source, "host baseline");
    git(source, "-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "plugins/system");
    git(source, "commit", "-qam", "add module");
    git(source, "-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "vendor/gt-manual");
    git(source, "commit", "-qam", "add vendor");
    const before = git(source, "rev-parse", "HEAD");
    const newModule = await commit(module, "module update");
    const child = join(source, "plugins/system");
    git(child, "fetch", "-q", "origin"); git(child, "checkout", "-q", newModule);
    git(join(source, "vendor/gt-manual"), "fetch", "-q", "origin");
    git(join(source, "vendor/gt-manual"), "checkout", "-q", newModule);
    const updated = await commit(source, "host update");
    await checkoutUpdateRevision(source, updated, next);
    await seedUpdateSubmodules(source, next);
    await initializeUpdateSubmodules(next, join(temporary, "cache"));
    // Preserve a real old checkout to distinguish old/new host and submodule pins.
    const previous = join(temporary, "previous");
    await checkoutUpdateRevision(source, before, previous);
    await seedUpdateSubmodules(source, previous);
    expect(git(previous, "rev-parse", "HEAD")).toBe(before);
    expect(git(join(previous, "plugins/system"), "rev-parse", "HEAD")).toBe(oldModule);
    const reports = await readAppliedUpdateReports(previous, next, []);
    expect(reports.map(item => item.name)).toEqual(["Lotus-Yunzai", "system", "vendor.gt-manual"]);
    expect(reports[0]!.lines).toHaveLength(1);
    expect(reports[0]!.lines[0]).toContain("host update");
    expect(reports[1]!.lines).toHaveLength(1);
    expect(reports[1]!.lines[0]).toContain("module update");
    expect(reports.flatMap(item => item.lines).join("\n")).not.toContain("baseline");
    expect(describeAppliedUpdates(reports)).toContain("Lotus-Yunzai 更新完成\n更新时间：");
    expect(reports[2]!.lines[0]).toContain("module update");
    expect(appliedUpdateLogNodes(reports)).toHaveLength(6);
    const receipts = createProcessReceipts(pathToFileURL(next + "/"));
    await receipts.save({ kind: "update", result: "updated", at: Date.now(), revision: updated, reports, target: { type: "terminal" } });
    expect((await createProcessReceipts(pathToFileURL(next + "/")).takeUpdate())?.kind).toBe("update");
    await receipts.save({ kind: "update", result: "updated", at: Date.now(), revision: updated, reports, target: { type: "private", botId: 99, id: 42, adapter: "milky" } });
    expect(await receipts.takeUpdate(99, "milky")).toMatchObject({ reports });
    expect(await readAppliedUpdateReports(next, next, [])).toEqual([]);
    const statuses: ManagedUpdateProgress[] = [];
    await reportCurrentUpdate("system", join(next, "plugins/system"), newModule, value => statuses.push(value));
    expect(statuses[0]).toMatch(/^dated:system:\d{4}-/u);
    expect(isManagedUpdateProgress(statuses[0])).toBe(true);
    expect(isTerminalManagedUpdateProgress(statuses[0]!)).toBe(false);
    // The checkout is independent: removing source objects does not break it.
    await rm(source, { recursive: true, force: true });
    await rm(module, { recursive: true, force: true });
    expect(git(join(next, "plugins/system"), "fsck", "--connectivity-only", "--no-dangling")).toBe("");
    expect(await readFile(join(next, "plugins/system/value"), "utf8")).toBe("module update");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("本地子模块已有锁定对象时不访问远端，缺少对象或URL变化时留给正常同步", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-submodule-seed-"));
  try {
    const host = join(temporary, "host"), remote = join(temporary, "remote"), next = join(temporary, "next");
    await mkdir(host); await mkdir(remote);
    git(remote, "init", "-q"); await commit(remote, "module");
    git(host, "init", "-q"); await commit(host, "host");
    git(host, "-c", "protocol.file.allow=always", "submodule", "add", "-q", remote, "plugins/system");
    git(host, "commit", "-qam", "module");
    const revision = git(host, "rev-parse", "HEAD");
    await rm(remote, { recursive: true, force: true });
    await checkoutUpdateRevision(host, revision, next);
    await seedUpdateSubmodules(host, next);
    await initializeUpdateSubmodules(next, join(temporary, "cache"));
    expect(git(join(next, "plugins/system"), "rev-parse", "HEAD")).toBe(git(join(host, "plugins/system"), "rev-parse", "HEAD"));
    const changed = join(temporary, "changed");
    git(host, "config", "--file", ".gitmodules", "submodule.plugins/system.url", "https://example.invalid/changed.git");
    git(host, "add", ".gitmodules"); git(host, "commit", "-qm", "change URL");
    await checkoutUpdateRevision(host, git(host, "rev-parse", "HEAD"), changed);
    await seedUpdateSubmodules(host, changed);
    expect(await Bun.file(join(changed, "plugins/system/.git/config")).exists()).toBe(false);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("更新日志回执拒绝控制字符、重复项目与超限条目", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-update-receipt-bounds-"));
  try {
    const receipts = createProcessReceipts(pathToFileURL(temporary + "/"));
    const report = { name: "system", date: "2026-11-27 22:00:00", lines: ["update"] };
    for (const reports of [[{ ...report, lines: ["injected\nline"] }], [report, report],
      [{ ...report, lines: Array(101).fill("update") }]]) {
      await expect(receipts.save({ kind: "update", result: "updated", at: Date.now(), revision: "a".repeat(40),
        target: { type: "terminal" }, reports })).rejects.toThrow();
    }
    for (const value of ["phase:build", "phase:verify", "dated:system:2026-11-27 22:00:00"]) {
      expect(isManagedUpdateProgress(value)).toBe(true);
      expect(isTerminalManagedUpdateProgress(value as ManagedUpdateProgress)).toBe(false);
    }
    for (const value of ["phase:done", "dated:system:secret\ntext", "dated:system:today"]) expect(isManagedUpdateProgress(value)).toBe(false);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
