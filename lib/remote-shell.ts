import { spawn } from "node:child_process";

export const remoteShells = ["bash", "sh", "zsh", "pwsh", "powershell", "cmd"] as const;
export type RemoteShell = typeof remoteShells[number];

export async function remoteShell(root: string, shell: RemoteShell, command: string, signal: AbortSignal, timeout: number) {
  signal.throwIfAborted();
  const executable = Bun.which(shell);
  if (!executable) return "系统未安装所选 Shell。";
  const windows = process.platform === "win32";
  const args = shell === "cmd" ? ["/d", "/q", "/c", command]
    : shell === "pwsh" || shell === "powershell" ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];
  const child = spawn(executable, args, {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: !windows,
    env: Object.fromEntries(["PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "USERPROFILE", "SystemRoot", "SystemDrive"]
      .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]])),
    windowsHide: true,
  });
  const maxBytes = 12_000;
  const output: Buffer[] = [];
  let remaining = maxBytes;
  let truncated = false;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk: Buffer) => {
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) {
        const piece = chunk.subarray(0, remaining);
        output.push(piece);
        remaining -= piece.length;
      }
    });
  }

  const stop = () => {
    if (child.pid === undefined) return;
    try { process.kill(windows ? child.pid : -child.pid, "SIGKILL"); }
    catch {}
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
    child.stdout.destroy();
    child.stderr.destroy();
  }, timeout);
  try {
    const result = await new Promise<{ code: number | null } | undefined>((resolve) => {
      child.once("error", () => resolve(undefined));
      child.once("close", code => resolve({ code }));
    });
    if (!result) return "无法启动所选 Shell。";
    if (timedOut) return "远程命令超时，已终止进程。";
    const summary = Buffer.concat(output).toString("utf8")
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "")
      .replace(/(?:cookie|authorization|password|passwd|stoken|secret|token)[\t ]*[:=][\t ]*[^\r\n]+/giu, "[已隐藏凭据]")
      .slice(0, 220);
    return [`命令已结束，退出码 ${result.code ?? "未知"}。`, summary,
      truncated ? "输出超过限制，已截断。" : undefined].filter(Boolean).join("\n");
  } finally {
    clearTimeout(timer);
    stop();
    signal.removeEventListener("abort", stop);
  }
}
