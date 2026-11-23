import { spawn } from "node:child_process";
import { windowsRemoteAdministrator, windowsRemoteJob } from "./remote-win32.ts";

export const remoteShells = ["bash", "sh", "zsh", "pwsh", "powershell", "cmd"] as const;
export type RemoteShell = typeof remoteShells[number];

export function isRemotePlatformSupported() {
  return process.platform === "linux" || process.platform === "win32" && ["x64", "arm64"].includes(process.arch);
}

export function isRemoteAdministrator() {
  return process.platform === "win32" ? windowsRemoteAdministrator() : process.getuid?.() === 0;
}

const windowsShellWorker = `
  const { spawn } = await import("node:child_process");
  const source = await Bun.stdin.text();
  if (!source) process.exit(1);
  const { executable, args, verbatim } = JSON.parse(source);
  const child = spawn(executable, args, {
    stdio: ["ignore", "inherit", "inherit"], windowsHide: true, windowsVerbatimArguments: verbatim,
  });
  child.on("error", () => process.exit(127));
  child.on("exit", code => process.exit(code ?? 1));
`;

export async function remoteShell(root: string, shell: RemoteShell, command: string, signal: AbortSignal, timeout: number) {
  signal.throwIfAborted();
  const executable = Bun.which(shell);
  if (!executable) return "系统未安装所选 Shell。";
  const windows = process.platform === "win32";
  const powershell = shell === "pwsh" || shell === "powershell";
  const script = powershell && windows ? Buffer.from(
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); " + command, "utf16le",
  ).toString("base64") : undefined;
  const args = shell === "cmd" ? ["/d", "/q", "/c", windows ? `chcp 65001>nul & ${command}` : command]
    : powershell ? ["-NoLogo", "-NoProfile", "-NonInteractive", ...(script ? ["-EncodedCommand", script] : ["-Command", command])] : ["-c", command];
  const child = spawn(windows ? process.execPath : executable,
    windows ? ["--no-env-file", "--no-install", "-e", windowsShellWorker] : args, {
      cwd: root, stdio: [windows ? "pipe" : "ignore", "pipe", "pipe"], detached: !windows,
      env: Object.fromEntries(["PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "USERPROFILE", "SystemRoot", "SystemDrive", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "ProgramData",
        "ProgramFiles", "ProgramFiles(x86)", "windir", "PSModulePath"]
        .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]])),
      windowsHide: true,
    });
  let terminateWindowsJob: (() => void) | undefined;
  if (windows) child.stdin?.on("error", () => {}); // Cancellation can close the worker before it reads the payload.
  if (windows && child.pid !== undefined) {
    try {
      terminateWindowsJob = windowsRemoteJob(child.pid);
      if (!signal.aborted) child.stdin?.end(JSON.stringify({ executable, args, verbatim: shell === "cmd" }));
      else child.stdin?.end();
    } catch {
      // No command is sent until the worker belongs to the job.
      child.stdin?.end();
      child.once("error", () => {});
      child.kill();
      return "无法建立 Windows 远程进程作业。";
    }
  }
  const maxBytes = 12_000;
  const output: Buffer[] = [];
  let remaining = maxBytes;
  let truncated = false;
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
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
    if (terminateWindowsJob) { terminateWindowsJob(); return; }
    try { process.kill(windows ? child.pid : -child.pid, "SIGKILL"); }
    catch {}
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }, timeout);
  try {
    const result = await new Promise<{ code: number | null } | undefined>((resolve) => {
      child.once("error", () => resolve(undefined));
      if (windows) child.once("exit", () => terminateWindowsJob?.());
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
