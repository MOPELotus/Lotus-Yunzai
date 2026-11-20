import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { activateUpdate, previousUpdateDirectory } from "../lib/update-activation.ts";
import { readWebMountUpdatePaths, verifyMovedWebMount } from "../lib/update-web-mount.ts";

async function fixture(run: (work: string, root: string, rootUrl: URL) => Promise<void>) {
  const work = await mkdtemp(join(tmpdir(), "lotus-update-web-mount-"));
  const root = join(work, "active");
  try {
    await mkdir(root);
    await run(work, root, pathToFileURL(root + sep));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === "win32")("preserves an exclusive Web Mount socket directory and its live endpoint", () =>
  fixture(async (work, root, rootUrl) => {
    const directory = join(work, "external-source");
    const runtime = join(root, "runtime");
    const socket = join(runtime, "rpc.sock");
    const webMount = { directory, socket };
    await mkdir(directory);
    await mkdir(runtime, { mode: 0o700 });
    await Bun.write(join(root, "config", "config", "server.yaml"), Bun.YAML.stringify({ web_mount: webMount }));
    const service = Bun.serve({ unix: socket, fetch: () => new Response("same service") });
    try {
      await chmod(socket, 0o600);
      const lock = socket + ".lock.sqlite3";
      await Bun.write(lock, "lock fixture");
      await chmod(lock, 0o600);
      const other = join(runtime, "other-data");
      await Bun.write(other, "unrelated service");
      await expect(readWebMountUpdatePaths(rootUrl)).rejects.toThrow("独占运行目录");
      await rm(other);
      const paths = await readWebMountUpdatePaths(rootUrl);
      expect(paths).toEqual(["runtime"]);
      const inodes = await Promise.all([runtime, socket, lock].map(path => lstat(path).then(info => info.ino)));
      const next = join(work, "candidate");
      await mkdir(next);
      await mkdir(join(next, "runtime"));
      await expect(activateUpdate(root, next, async () => {}, paths)).rejects.toThrow("候选目录占用");
      expect(await (await fetch("http://localhost/config", { unix: socket })).text()).toBe("same service");
      await rm(join(next, "runtime"), { recursive: true });
      const result = await activateUpdate(root, next, async (active) => {
        await verifyMovedWebMount(active, (await previousUpdateDirectory(active))!, webMount);
        expect(await (await fetch("http://localhost/config", { unix: socket })).text()).toBe("same service");
      }, paths);
      expect(await Promise.all([runtime, socket, lock].map(path => lstat(path).then(info => info.ino)))).toEqual(inodes);
      expect(await Bun.file(join(result.previous, "runtime", "rpc.sock.lock.sqlite3")).exists()).toBe(false);
    } finally {
      await service.stop(true);
    }
  }));

test.skipIf(process.platform === "win32")("rejects an archived socket parent and an installation-local original source", () =>
  fixture(async (work, root, rootUrl) => {
    const directory = join(root, "data", "external-node");
    const socket = join(work, "runtime", "rpc.sock");
    const previous = join(work, "previous");
    await mkdir(directory, { recursive: true });
    await Bun.write(join(root, "config", "server.yaml"), Bun.YAML.stringify({ web_mount: { directory, socket } }));
    await expect(readWebMountUpdatePaths(rootUrl)).rejects.toThrow("原版目录须位于");
    await rm(directory, { recursive: true });
    await mkdir(join(previous, "data", "external-node"), { recursive: true });
    await expect(verifyMovedWebMount(root, previous, { directory, socket })).rejects.toThrow("原版目录须位于");
    const external = join(work, "node-source");
    const rpc = join(root, "private", "rpc.sock");
    await mkdir(external);
    await mkdir(join(previous, "private"), { mode: 0o700 });
    await expect(verifyMovedWebMount(root, previous, { directory: external, socket: rpc })).rejects.toThrow("独占运行目录");
    const socketAlias = join(work, "link-to-private");
    await symlink(join(root, "private"), socketAlias);
    await expect(verifyMovedWebMount(root, previous, { directory: external, socket: join(socketAlias, "rpc.sock") })).rejects.toThrow("独占运行目录");
    const dangling = join(work, "external-alias");
    await symlink(directory, dangling);
    await expect(verifyMovedWebMount(root, previous, { directory: dangling, socket })).rejects.toThrow("原版目录须位于");
    await symlink(join(previous, "data", "external-node"), join(root, "source-alias"));
    await expect(verifyMovedWebMount(root, previous, { directory: join(root, "source-alias"), socket })).rejects.toThrow("原版目录须位于");

    await Bun.write(join(root, "config", "server.yaml"), Bun.YAML.stringify({ web_mount: { directory: external, socket } }));
    expect(await readWebMountUpdatePaths(rootUrl)).toEqual([]);
    await verifyMovedWebMount(root, previous, { directory: external, socket });
  }));
