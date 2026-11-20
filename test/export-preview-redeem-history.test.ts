import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/export-preview-redeem-history.ts", import.meta.url));

async function exportHistory(...args: string[]) {
  const child = Bun.spawn([process.execPath, script, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exit, output, errors] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exit, output, errors };
}

test("从两份副本导出旧插件可读账本，保留已完成和未确认状态，不覆盖文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-redeem-history-"));
  const previous = join(root, "previous.json");
  const current = join(root, "current.json");
  const target = join(root, "restore.json");
  const duplicate = "a".repeat(64), started = "b".repeat(64), finished = "c".repeat(64);
  const old = { [duplicate]: { time: 10, status: "finished" } };
  const recent = { __lotusPreviewJournalVersion: 1, [duplicate]: { time: 20, status: "started" },
    [started]: { time: 30, status: "started" }, [finished]: { time: 40, status: "finished" } };
  const oldBytes = JSON.stringify(old, null, 2) + "\r\n";
  const newBytes = JSON.stringify(recent);
  try {
    await Promise.all([writeFile(previous, oldBytes), writeFile(current, newBytes)]);
    const results = await Promise.all([
      exportHistory(current, previous, target), exportHistory(current, previous, target),
    ]);
    expect(results.map(result => result.exit).sort()).toEqual([0, 1]);
    expect(JSON.parse(results.find(result => result.exit === 0)!.output)).toEqual({ preserved: 1, added: 2, total: 3 });
    const exported = await readFile(target, "utf8");
    expect(JSON.parse(exported)).toEqual({ ...old, [started]: recent[started], [finished]: recent[finished] });
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readFile(previous, "utf8")).toBe(oldBytes);
    expect(await readFile(current, "utf8")).toBe(newBytes);
    expect((await exportHistory(current, "-", current)).exit).toBe(1);
    expect(await readFile(current, "utf8")).toBe(newBytes);

    await writeFile(current, JSON.stringify({ ...recent, [started]: { time: 30, status: "unknown" } }));
    const invalid = join(root, "invalid.json");
    const failed = await exportHistory(current, previous, invalid);
    expect(failed.exit).toBe(1);
    expect(failed.errors).not.toContain(started);
    expect(await Bun.file(invalid).exists()).toBe(false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
