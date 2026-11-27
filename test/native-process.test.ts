import { expect, test } from "bun:test";
import { runNativeCommand } from "../lib/native-process.ts";

test("native probes isolate SIGILL and do not expose URL credentials", async () => {
  const result = await runNativeCommand([process.execPath, "-e", 'console.error("https://user:private@fixture.invalid/model?token=secret");process.exit(132)'], { cwd: import.meta.dir });
  expect(result.code).toBe(132); expect(result.diagnostic).toContain("fixture.invalid/model");
  expect(result.diagnostic).not.toContain("private"); expect(result.diagnostic).not.toContain("secret");
});

test("timeouts and cancellation stop hung native subprocesses", async () => {
  const args = [process.execPath, "-e", "setInterval(()=>{},1000)"];
  const result = await runNativeCommand(args, { cwd: import.meta.dir, timeoutMs: 30 });
  expect(result.timedOut).toBe(true);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("fixture cancellation")), 30);
  try { await expect(runNativeCommand(args, { cwd: import.meta.dir, signal: controller.signal })).rejects.toThrow("fixture cancellation"); }
  finally { clearTimeout(timer); }
});
