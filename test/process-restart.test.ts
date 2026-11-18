import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const restartModule = JSON.stringify(fileURLToPath(new URL("../lib/process-restart.ts", import.meta.url)));

test.skipIf(process.platform === "win32" || typeof process.execve !== "function")(
  "Bun 重启在原 PID 中保留入口、启动参数和 stdio，恢复启动 cwd 并继承当前 env",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "lotus-process-restart-"));
    try {
      const changed = join(directory, "changed");
      const entry = join(directory, "entry.ts");
      await mkdir(changed);
      await writeFile(entry, `
        import { canRestartHost, restartHost } from ${restartModule};
        const snapshot = {
          pid: process.pid, argv: process.argv, execArgv: process.execArgv,
          execPath: process.execPath, cwd: process.cwd(), allowed: canRestartHost(),
        };
        if (process.env.LOTUS_RESTART_FIXTURE_PHASE === "before") {
          await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(snapshot) + "\\n", e => e ? reject(e) : resolve()));
          await new Promise((resolve, reject) => process.stderr.write("before stderr\\n", e => e ? reject(e) : resolve()));
          process.chdir(${JSON.stringify(changed)});
          process.argv.splice(1, 1, "invalid-runtime-entry");
          process.execArgv.push("--invalid-runtime-option");
          process.env.LOTUS_RESTART_FIXTURE_PHASE = "after";
          restartHost();
        }
        console.log(JSON.stringify({ ...snapshot, phase: process.env.LOTUS_RESTART_FIXTURE_PHASE, stdin: await Bun.stdin.text() }));
        console.error("after stderr");
      `);

      const child = Bun.spawn([process.execPath, "--smol", "entry.ts", "应用参数 with spaces", "--fixture"], {
        cwd: directory, env: { PATH: process.env.PATH, LOTUS_RESTART_FIXTURE_PHASE: "before" },
        stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 3_000, killSignal: "SIGKILL",
      });
      child.stdin.write("跨重启保留的输入\n");
      await child.stdin.end();
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exit).toBe(0);
      expect(stderr).toBe("before stderr\nafter stderr\n");
      const [before, after] = stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
      expect(before).toEqual({ pid: child.pid, argv: [process.execPath, await realpath(entry), "应用参数 with spaces", "--fixture"],
        execArgv: ["--smol"], execPath: process.execPath, cwd: await realpath(directory), allowed: true });
      expect(after).toEqual({ ...before, phase: "after", stdin: "跨重启保留的输入\n" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("execve 不可用时给出明确错误", async () => {
  const child = Bun.spawn([process.execPath, "-e", `
    import { canRestartHost, restartHost } from ${restartModule};
    process.execve = undefined;
    try { restartHost(); }
    catch (error) { console.log(JSON.stringify({ available: canRestartHost(), message: error.message })); }
  `, "fixture"], { stdout: "pipe", stderr: "pipe", timeout: 3_000, killSignal: "SIGKILL" });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ available: false, message: "当前运行环境不支持进程内重启，需由部署管理器重启。" });
});
