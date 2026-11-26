import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalGit } from "../lib/local-git.ts";

test("网络拉取耗时超过本地 Git 查询预算仍可读到候选差异", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-local-git-"));
  try {
    expect(await Bun.spawn(["git", "init", "--quiet", "--initial-branch=main", root]).exited).toBe(0);
    const paths = Array.from({ length: 6000 }, (_, i) => `resources/${"a".repeat(100)}/${i}.txt`);
    const body = "blob\nmark :1\ndata 1\nx\ncommit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ndata 0\n" +
      paths.map(path => `M 100644 :1 ${path}\n`).join("") + "\ndone\n";
    const child = Bun.spawn(["git", "-C", root, "fast-import", "--quiet"], { stdin: "pipe", stderr: "ignore" });
    child.stdin.write(body);
    child.stdin.end();
    expect(await child.exited).toBe(0);
    const git = createLocalGit()!;
    const tree = await git(root, ["ls-tree", "-r", "-z", "HEAD"]);
    expect(tree!.length).toBeGreaterThan(512 * 1024);
    expect(tree!.split("\0").filter(Boolean)).toHaveLength(paths.length);
    await Bun.sleep(10_100);
    expect((await git(root, ["rev-parse", "--verify", "HEAD"]))?.trim()).toMatch(/^[0-9a-f]{40}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
