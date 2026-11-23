import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readRemoteFile, writeRemoteFile } from "../lib/remote-files.ts";
import { rotateRemoteOtp, remoteOtpPaired } from "../lib/remote-otp.ts";
import { isRemoteAdministrator, remoteShell } from "../lib/remote-shell.ts";

test.skipIf(process.platform !== "win32")("Windows 运维保留 cmd、退出结果及作业超时", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-win-remote-shell-"));
  const signal = new AbortController().signal;
  try {
    expect(typeof isRemoteAdministrator()).toBe("boolean");
    expect(await remoteShell(root, "cmd", "echo hello", signal, 8_000)).toContain("退出码 0。\nhello");
    expect(await remoteShell(root, "cmd", 'cmd /d /q /c "pause" & exit /b 7', signal, 8_000)).toContain("退出码 7。");
    expect(await remoteShell(root, "cmd", "ping -n 100 127.0.0.1", signal, 1_000)).toContain("远程命令超时");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);

test.skipIf(process.platform !== "win32" || !Bun.which("powershell"))(
  "Windows PowerShell 保留中文，管理员检查匹配 Windows token，作业关闭清理后代",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lotus-win-remote-powershell-"));
    const signal = new AbortController().signal;
    try {
      const membership = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"],
        { encoding: "utf8", timeout: 15_000, windowsHide: true });
      expect(membership.status).toBe(0);
      expect(isRemoteAdministrator()).toBe(/^true$/iu.test(membership.stdout.trim()));
      expect(await remoteShell(root, "powershell", "Write-Output '远程中文'", signal, 30_000)).toContain("远程中文");
      const inner = Buffer.from("Start-Sleep -Seconds 4; Set-Content -LiteralPath survived.txt -Value alive", "utf16le").toString("base64");
      const command = `Start-Process powershell.exe -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${inner}'; Start-Sleep -Seconds 25`;
      expect(await remoteShell(root, "powershell", command, signal, 2_500)).toContain("远程命令超时");
      await Bun.sleep(5_000);
      await expect(access(join(root, "survived.txt"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  55_000,
);

test.skipIf(process.platform !== "win32")("Windows 运维文件固定目录，拒绝备用流和设备名称", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-win-remote-files-"));
  const files = join(root, "data", "remote", "files");
  const data = Buffer.from("sample");
  const signal = new AbortController().signal;
  try {
    await mkdir(files, { recursive: true });
    expect(await writeRemoteFile(root, "report.txt", data, false, () => true)).toBe(true);
    expect((await readRemoteFile(root, "report.txt", signal))?.bytes.toString()).toBe("sample");
    expect(await writeRemoteFile(root, "report.txt", Buffer.from("replaced"), true, () => true)).toBe(true);
    expect(await readFile(join(files, "report.txt"), "utf8")).toBe("replaced");
    for (const name of ["..\\outside.txt", "report.txt:alternate", "NUL.txt", "file."]) {
      expect(await writeRemoteFile(root, name, data, false, () => true)).toBe(false);
    }

  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test.skipIf(process.platform !== "win32")("Windows 运维不跟随目录联接且 TOTP 要求受保护权限", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-win-remote-guard-"));
  const files = join(root, "data", "remote", "files");
  try {
    const outside = join(root, "outside");
    await mkdir(outside);
    await mkdir(files, { recursive: true });
    await symlink(outside, join(files, "hidden"), "junction");
    await expect(writeRemoteFile(root, "hidden\\report.txt", Buffer.from("unsafe"), false, () => true)).rejects.toThrow();
    expect(() => rotateRemoteOtp(root, false)).not.toThrow();
    expect(remoteOtpPaired(root)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
