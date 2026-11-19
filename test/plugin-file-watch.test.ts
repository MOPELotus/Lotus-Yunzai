import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { watchLegacyFiles } from "../lib/plugins/file-watch.ts";

async function fixture(run: (temporary: string, root: string) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-yunzai-plugin-watch-"));
  const root = join(temporary, "plugins");
  try {
    await mkdir(root);
    await run(temporary, root);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

async function until(predicate: () => boolean, failure: string) {
  const deadline = performance.now() + 3_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(failure);
    await Bun.sleep(10);
  }
}

async function scripts(directory: string): Promise<string[]> {
  try {
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"));
    return Promise.all(files.sort((left, right) => left.name.localeCompare(right.name)).map(async ({ name }) =>
      `${name}:${await readFile(join(directory, name), "utf8")}`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test("监听订阅后复查批准目录，合并写入、原子替换和删除，并忽略未批准目录", () => fixture(async (_temporary, root) => {
  const approved = join(root, "flat");
  const ignored = join(root, "others");
  await mkdir(approved);
  await mkdir(ignored);
  await writeFile(join(approved, "existing.js"), "existing");

  const snapshots: string[][] = [];
  const visited: string[] = [];
  const watcher = watchLegacyFiles(root, [approved], async (directory) => {
    visited.push(basename(directory));
    snapshots.push(await scripts(directory));
  }, { debounceMs: 35 });
  try {
    await until(() => snapshots.length === 1, "启动未复查原有插件。");
    expect(snapshots[0]).toEqual(["existing.js:existing"]);
    await writeFile(join(ignored, "not-watched.js"), "ignored");
    await mkdir(join(root, "new-plugin"));
    await writeFile(join(root, "new-plugin", "not-watched.js"), "ignored");

    const target = join(approved, "new.js");
    await writeFile(target, "added");
    await until(() => snapshots.at(-1)?.includes("new.js:added") === true, "未发现新脚本。");
    const before = snapshots.length;
    await writeFile(target, "first write");
    await writeFile(target, "second write");
    await writeFile(join(approved, ".editor-temp"), "last write");
    await rename(join(approved, ".editor-temp"), target);
    await until(() => snapshots.at(-1)?.includes("new.js:last write") === true, "原子保存的内容未被发现。");
    expect(snapshots.slice(before)).toEqual([["existing.js:existing", "new.js:last write"]]);

    await unlink(target);
    await until(() => snapshots.at(-1)?.length === 1, "删除脚本后未复查。");
    expect(snapshots.at(-1)).toEqual(["existing.js:existing"]);
    expect(visited.every((name) => name === "flat")).toBe(true);
  } finally {
    await watcher.stop();
  }
}));

test("已批准目录删除和同名替换后重新绑定，后续写入仍会刷新", () => fixture(async (temporary, root) => {
  const directory = join(root, "flat");
  const replacement = join(temporary, "replacement");
  await mkdir(directory);
  await mkdir(replacement);
  await writeFile(join(directory, "before.js"), "original");
  await writeFile(join(replacement, "after.js"), "replacement");

  const snapshots: string[][] = [];
  const watcher = watchLegacyFiles(root, [directory], async (path) => { snapshots.push(await scripts(path)); }, { debounceMs: 30 });
  try {
    await until(() => snapshots.at(-1)?.includes("before.js:original") === true, "未观察到原目录。");
    await rename(directory, join(temporary, "retired"));
    await until(() => snapshots.at(-1)?.length === 0, "删除目录后未清理快照。");
    await rename(replacement, directory);
    await until(() => snapshots.at(-1)?.includes("after.js:replacement") === true, "没有绑定同名替换目录。");
    await writeFile(join(directory, "after.js"), "subsequent change");
    await until(() => snapshots.at(-1)?.includes("after.js:subsequent change") === true, "替换后未监听后续修改。");
  } finally {
    await watcher.stop();
  }
}));

test("直接子目录中的持续无关写入不会延迟批准脚本的复查", () => fixture(async (_temporary, root) => {
  const directory = join(root, "flat");
  await mkdir(directory);
  const script = join(directory, "plugin.js");
  await writeFile(script, "old");
  const snapshots: string[][] = [];
  let ignored = 0;
  let writing = true;
  const watcher = watchLegacyFiles(root, [directory], async (path) => { snapshots.push(await scripts(path)); }, {
    debounceMs: 80,
    relevantFile(name) {
      if (name === "state.json") ignored++;
      return name.endsWith(".js");
    },
  });
  const noise = (async () => {
    while (writing) {
      await writeFile(join(directory, "state.json"), String(ignored));
      await Bun.sleep(8);
    }
  })();
  try {
    await until(() => snapshots.length === 1 && ignored > 1, "初始复查或无关文件监听未就绪。");
    const before = ignored;
    await writeFile(script, "changed");
    await until(() => snapshots.at(-1)?.includes("plugin.js:changed") === true, "脚本更改被无关写入推迟。");
    expect(snapshots).toEqual([["plugin.js:old"], ["plugin.js:changed"]]);
    expect(ignored - before).toBeGreaterThan(1);
  } finally {
    writing = false;
    await noise;
    await watcher.stop();
  }
}));

test("复查全局串行，繁忙时合并最新扫描，停机等待当前回调退出", () => fixture(async (_temporary, root) => {
  const first = join(root, "first");
  const second = join(root, "second");
  await mkdir(first);
  await mkdir(second);
  const controller = new AbortController();
  const held = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let inFlight = 0;
  let parallel = false;
  let block = true;
  const scans: { name: string; files: string[] }[] = [];
  const watcher = watchLegacyFiles(root, [first, second], async (path) => {
    if (++inFlight > 1) parallel = true;
    try {
      scans.push({ name: basename(path), files: await scripts(path) });
      if (block && path === first) {
        held.resolve();
        await released.promise;
      }
    } finally {
      inFlight--;
    }
  }, { signal: controller.signal, debounceMs: 25 });

  try {
    await held.promise;
    await writeFile(join(first, "changed.js"), "intermediate");
    await writeFile(join(first, "changed.js"), "final");
    await writeFile(join(second, "pending.js"), "pending");
    await Bun.sleep(80);
    expect(scans).toEqual([{ name: "first", files: [] }]);
    block = false;
    released.resolve();
    await until(() => scans.length === 3, "繁忙期间新增的两份快照未被刷新。");
    expect(scans).toContainEqual({ name: "first", files: ["changed.js:final"] });
    expect(scans).toContainEqual({ name: "second", files: ["pending.js:pending"] });
    expect(parallel).toBe(false);
  } finally {
    released.resolve();
    await watcher.stop();
  }

  const entering = Promise.withResolvers<void>();
  const exiting = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  let calls = 0;
  const scheduled = watchLegacyFiles(root, [first, second], async (_path, signal) => {
    calls++;
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    entering.resolve();
    await exiting.promise;
  }, { signal: controller.signal, debounceMs: 25 });
  try {
    await entering.promise;
    await writeFile(join(first, "changed.js"), "about to stop");
    controller.abort();
    await aborted.promise;
    const stop = scheduled.stop();
    expect(scheduled.stop()).toBe(stop);
    let stopped = false;
    void stop.then(() => { stopped = true; });
    await Bun.sleep(45);
    expect(stopped).toBe(false);
    exiting.resolve();
    await stop;
    await writeFile(join(second, "pending.js"), "stopped");
    await Bun.sleep(45);
    expect(calls).toBe(1);
  } finally {
    exiting.resolve();
    await scheduled.stop();
  }
}));
