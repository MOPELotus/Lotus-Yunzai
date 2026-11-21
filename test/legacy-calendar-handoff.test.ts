import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../scripts/prepare-legacy-calendar.ts", import.meta.url));
const state = { version: 1, whiteList: [77, 78], blackList: [77], tasks: [{ cron: "0 3 31 12 *", type: "G" }] };

async function prepare(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, "--no-env-file", entry, ...args], {
    cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 3_000,
  });
  const [code, output, error] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output, error };
}

test("定时日历三份交还文件一起发布，并发及重跑保留完整导出", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lotus-legacy-calendar-"));
  try {
    const snapshot = join(cwd, "snapshot.json");
    const output = join(cwd, "exports");
    await mkdir(output);
    const original = JSON.stringify(state);
    await writeFile(snapshot, original);
    const preview = await prepare(cwd, snapshot);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.output)).toEqual({ mode: "dry-run", whiteList: 2, blackList: 1, tasks: 1, changed: false });
    expect(await readdir(output)).toEqual([]);

    const results = await Promise.all([prepare(cwd, "--export", output, snapshot), prepare(cwd, "--export", output, snapshot)]);
    expect(results.map(({ code }) => code)).toEqual([0, 0]);
    const runs = results.map(({ output }) => JSON.parse(output));
    expect(runs.map(({ changed }) => changed).sort()).toEqual([false, true]);
    const directory = runs[0].directory;
    expect(runs[1].directory).toBe(directory);
    expect(await readdir(output)).toEqual([basename(directory)]);
    expect((await readdir(directory)).sort()).toEqual(["AutoCalendarBlackList.json", "AutoCalendarTasks.json", "AutoCalendarWhiteList.json"]);
    expect(JSON.parse(await readFile(join(directory, "AutoCalendarBlackList.json"), "utf8"))).toEqual(["77"]);
    expect(JSON.parse(await readFile(join(directory, "AutoCalendarWhiteList.json"), "utf8"))).toEqual(["77", "78"]);
    expect(JSON.parse(await readFile(join(directory, "AutoCalendarTasks.json"), "utf8"))).toEqual(state.tasks);
    expect(await readFile(snapshot, "utf8")).toBe(original);
    expect(JSON.parse((await prepare(cwd, "--export", output, snapshot)).output).changed).toBe(false);

    const separatelyEdited = join(directory, "AutoCalendarWhiteList.json");
    await writeFile(separatelyEdited, '["99"]');
    const conflict = await prepare(cwd, "--export", output, snapshot);
    expect(conflict.code).toBe(1);
    expect(conflict.error).toContain("已有导出目录的内容不一致");
    expect(await readFile(separatelyEdited, "utf8")).toBe('["99"]');
    await rm(separatelyEdited);
    expect((await prepare(cwd, "--export", output, snapshot)).code).toBe(1);
    expect((await readdir(directory)).sort()).toEqual(["AutoCalendarBlackList.json", "AutoCalendarTasks.json"]);
    await rm(join(directory, "AutoCalendarBlackList.json"));
    await rm(join(directory, "AutoCalendarTasks.json"));
    expect((await prepare(cwd, "--export", output, snapshot)).code).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("旧日历输出拒绝无法移交的路由配置与软链副本", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lotus-legacy-calendar-invalid-"));
  try {
    const snapshot = join(cwd, "snapshot.json");
    await writeFile(snapshot, JSON.stringify({ ...state, tasks: [{ ...state.tasks[0], botId: 99 }] }));
    const invalid = await prepare(cwd, "--export", cwd, snapshot);
    expect(invalid.code).toBe(1);
    expect(invalid.error).toContain("旧版不能表示");
    await writeFile(snapshot, JSON.stringify(state));
    const link = join(cwd, "linked.json");
    await symlink(snapshot, link);
    expect((await prepare(cwd, "--export", cwd, link)).code).toBe(1);
    expect((await readdir(cwd)).sort()).toEqual(["linked.json", "snapshot.json"]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
