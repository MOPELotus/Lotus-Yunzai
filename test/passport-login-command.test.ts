import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { passportLoginCommands } from "../lib/passport-login.ts";

test("扫码入口只使用当前的好友会话，断开会取消尚在创建的二维码", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-passport-command-"));
  const originalFetch = globalThis.fetch;
  try {
    const requests: AbortSignal[] = [];
    const started = Promise.withResolvers<void>();
    globalThis.fetch = (async (url, init) => {
      expect(new URL(String(url)).pathname.endsWith("/createQRLogin")).toBe(true);
      const signal = init?.signal;
      if (!signal) throw new Error("扫码请求缺少会话信号");
      requests.push(signal);
      started.resolve();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const fallback = passportLoginCommands(root, new AbortController().signal).fallback!;
    const messages: unknown[] = [];
    const context = { user_id: 42, self_id: 51, message_type: "private", isMaster: false,
      normalizedMessage: "#扫码登录2", isBotMaster: () => false,
      reply: async (reply: unknown) => { messages.push(reply); return true; } } as const;
    const closed = AbortSignal.abort();
    expect(await fallback("", context)).toContain("当前连接");
    expect(await fallback("", { ...context, privateCredentialSignal: closed })).toContain("当前连接");
    expect(await fallback("", { ...context, message_type: "terminal" })).toContain("请私聊");
    expect(requests).toHaveLength(0);
    const connection = new AbortController();
    const pending = fallback("", { ...context, privateCredentialSignal: connection.signal });
    await started.promise;
    connection.abort();
    expect(await pending).toEqual([]);
    expect(requests.every(signal => signal.aborted)).toBe(true);
    expect(messages).toHaveLength(1);
    expect(await readdir(root)).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
