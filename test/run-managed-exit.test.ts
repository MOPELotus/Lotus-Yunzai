import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopForeground } from "../lib/foreground-control.ts";

async function fixture(startupExit?: number) {
  const root = await mkdtemp(join(tmpdir(), "lotus-foreground-exit-"));
  const managed = new URL("../scripts/run-managed.ts", import.meta.url).href;
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { start: "bun fixture-start.ts" } }));
  await writeFile(join(root, "fixture-start.ts"), `
    import { runManaged } from ${JSON.stringify(managed)};
    console.log("fixture-supervisor " + process.pid);
    process.exitCode = await runManaged(process.cwd());
  `);
  await writeFile(join(root, "app.ts"), `
    if (Bun.env.FIXTURE_STARTUP_EXIT) process.exit(Number(Bun.env.FIXTURE_STARTUP_EXIT));
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.on(signal, () => process.exit(code));
    process.send({ type: "lotus-ready", token: Bun.env.LOTUS_MANAGED_TOKEN });
    console.log("fixture-worker-ready");
    setInterval(async () => {
      const file = Bun.file("exit-worker");
      if (await file.exists()) process.exit(Number(await file.text()));
    }, 10);
  `);
  const child = Bun.spawn([process.execPath, "run", "start"], {
    cwd: root, env: { PATH: process.env.PATH, FIXTURE_STARTUP_EXIT: startupExit?.toString() },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 6_000, killSignal: "SIGKILL",
  });
  const reader = child.stdout.getReader();
  const stderr = new Response(child.stderr).text();
  let output = "", supervisor = 0;
  async function ready() {
    while (!output.includes("fixture-worker-ready")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`fixture failed: ${output}\n${await stderr}`);
      output += new TextDecoder().decode(chunk.value);
    }
    supervisor = Number(/fixture-supervisor (\d+)/u.exec(output)?.[1]);
    if (!supervisor) throw new Error("Missing managed supervisor PID");
  }
  async function close() {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited; await reader.cancel(); await rm(root, { recursive: true, force: true });
  }
  return { root, child, stderr, ready, close, signal: (signal: "SIGINT" | "SIGTERM") => process.kill(supervisor, signal) };
}

test.skipIf(process.platform === "win32")("bun run start 接受SIGINT/SIGTERM及可信前台停止后正常退出0", async () => {
  for (const method of ["SIGINT", "SIGTERM", "control"] as const) {
    const host = await fixture();
    try {
      await host.ready();
      if (method === "control") expect(await stopForeground(host.root)).toBe(true);
      else host.signal(method);
      expect(await host.child.exited).toBe(0);
      expect(await host.stderr).not.toContain("exited with code");
    } finally { await host.close(); }
  }
}, 20_000);

test.skipIf(process.platform === "win32")("无停止请求的143/137和真正启动异常保持失败退出", async () => {
  for (const status of [143, 137, 42]) {
    const host = await fixture();
    try {
      await host.ready(); await writeFile(join(host.root, "exit-worker"), String(status));
      expect(await host.child.exited).toBe(status);
    } finally { await host.close(); }
  }
  const failed = await fixture(42);
  try { expect(await failed.child.exited).toBe(42); }
  finally { await failed.close(); }
}, 25_000);
