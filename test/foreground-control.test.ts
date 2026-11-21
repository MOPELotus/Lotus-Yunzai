import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile, managedHostLockPath } from "../lib/file-lock.ts";
import { serveForegroundControl, stopForeground } from "../lib/foreground-control.ts";

test.skipIf(process.platform === "win32")("前台停止拒绝无可信通道的活动锁与过期或非套接字记录", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lotus-foreground-control-")));
  const lockPath = managedHostLockPath(root);
  const directory = join("/tmp", `lotus-yunzai-control-${process.getuid!()}`);
  const socket = join(directory, createHash("sha256").update(root).digest("hex") + ".sock");
  try {
    expect(await stopForeground(root)).toBe(false);
    const lock = await lockFile(lockPath, "夹具");
    try {
      await expect(stopForeground(root)).rejects.toThrow("无法核实前台停止入口");
    } finally {
      lock.close();
    }

    await mkdir(directory, { mode: 0o700, recursive: true });
    await writeFile(socket, "invalid", { mode: 0o600, flag: "wx" });
    await expect(stopForeground(root)).rejects.toThrow("类型、所有者或权限无法核实");
    await rm(socket);
    const socketOwner = Bun.spawn([process.execPath, "--eval", `
      import { chmodSync } from "node:fs";
      const server = Bun.listen({ unix: ${JSON.stringify(socket)}, socket: { data() {} } });
      chmodSync(${JSON.stringify(socket)}, 0o600);
      console.log("bound");
    `], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const reader = socketOwner.stdout.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("bound");
    } finally {
      socketOwner.kill("SIGKILL");
      await socketOwner.exited;
      await reader.cancel();
    }
    await expect(stopForeground(root)).rejects.toThrow("前台控制入口已过期");
    const renewed = await lockFile(lockPath, "夹具");
    try {
      const close = await serveForegroundControl(root, () => {});
      expect(close).toBeDefined();
      close?.();
    } finally {
      renewed.close();
    }
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(lockPath, { force: true }), rm(socket, { force: true })]);
  }
});

test.skipIf(process.platform === "win32")("同安装的独立客户端等待前台主管退出", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lotus-foreground-control-active-")));
  const lockPath = managedHostLockPath(root);
  const mark = join(root, "finished");
  const source = new URL("../lib/foreground-control.ts", import.meta.url).href;
  const locks = new URL("../lib/file-lock.ts", import.meta.url).href;
  const host = Bun.spawn([process.execPath, "--eval", `
    import { serveForegroundControl } from ${JSON.stringify(source)};
    import { lockFile, managedHostLockPath } from ${JSON.stringify(locks)};
    const root = ${JSON.stringify(root)};
    const lock = await lockFile(managedHostLockPath(root), "前台夹具");
    const stop = Promise.withResolvers();
    const close = await serveForegroundControl(root, stop.resolve);
    console.log("ready");
    const keepAlive = setInterval(() => {}, 1000);
    await stop.promise;
    await Bun.sleep(120);
    await Bun.write(${JSON.stringify(mark)}, "done");
    clearInterval(keepAlive);
    close();
    lock.close();
  `], { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 5_000 });
  const reader = host.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    expect(await stopForeground(root)).toBe(true);
    expect(await host.exited).toBe(0);
    expect(await Bun.file(mark).text()).toBe("done");
    expect(await stopForeground(root)).toBe(false);
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    await host.exited;
    await reader.cancel();
    await Promise.all([rm(root, { recursive: true, force: true }), rm(lockPath, { force: true })]);
  }
});
