import { expect, test } from "bun:test";
import { formatTerminalLog } from "../lib/terminal-log-format.ts";
const now = new Date("2026-11-24T12:34:56.789Z");

test("TRSS时间与级别样式采用北京时间，TTY分级着色且重定向无转义码", () => {
  expect(formatTerminalLog("info", "[图鉴] 已就绪", { now, color: false })).toBe("[20:34:56.789][INFO] [图鉴] 已就绪");
  const warning = formatTerminalLog("warn", "[初始化] 缺少文件", { now, color: true });
  expect(warning).toContain("\x1b[33m[20:34:56.789][WARN]\x1b[0m");
  expect(warning).toContain("\x1b[34m[初始化]\x1b[0m");
  expect(formatTerminalLog("fatal", "失败", { now, color: false, fullLevel: true })).toContain("[FATAL]");
});

test("跨入口格式不重复加前缀，格式化仍脱敏凭据和终端控制字符", () => {
  const initial = formatTerminalLog("error", "token=fixture-secret", { now, color: true });
  const repeated = formatTerminalLog("info", initial, { color: false });
  expect(repeated).toBe("[20:34:56.789][ERRO] [LOTUS-YUNZAI] token=[已隐藏]");
  expect(repeated).not.toContain("fixture-secret");
  expect(formatTerminalLog("info", "\x1b[2J危险\n伪造行", { now, color: false })).not.toContain("\x1b");
});
