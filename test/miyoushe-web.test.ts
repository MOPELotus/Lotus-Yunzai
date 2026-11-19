import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageFallbackContext } from "../lib/commands.ts";
import type { MiyousheOverviewTarget } from "../lib/miyoushe-overview.ts";
import { createMiyousheWeb } from "../lib/miyoushe-web.ts";

const origin = new URL("https://miyoushe.example.org");
const command = "#米游社功能2";
const session = new AbortController();

function message(overrides: Partial<MessageFallbackContext> = {}): MessageFallbackContext {
  return { message_type: "private", self_id: 99, user_id: 42, isMaster: false, normalizedMessage: command,
    privateCredentialSignal: session.signal, reply: () => true, isBotMaster: () => false, ...overrides };
}

function request(path: string, init: RequestInit = {}) {
  return new Request(new URL(`/miyoushe/${path}`, origin), init);
}

function claim(ticket: string, from = origin.origin) {
  return request("api/claim", { method: "POST", headers: { Origin: from, "Content-Type": "application/json" }, body: JSON.stringify({ ticket }) });
}

function read(cookie: string, site = "same-origin") {
  return request("api/overview", { headers: { Cookie: cookie, "Sec-Fetch-Site": site } });
}

test("米游社浏览器票只从绑定好友获取，一次兑换并绑定档案，会话重启后可用", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-miyoushe-web-"));
  const databasePath = join(root, "auth.sqlite");
  const verified: unknown[] = [];
  let now = 1_000;
  let account = "first-login";
  const options = {
    origin: () => origin, databasePath, assetDirectory: "web/miyoushe", signal: new AbortController().signal,
    now: () => now,
    async loginIdentity(qq: string, profileId: number) { verified.push([qq, profileId]); return account; },
    async overview({ qq, profileId }: MiyousheOverviewTarget, _signal?: AbortSignal, verify?: () => Promise<void>) {
      expect([qq, profileId]).toEqual(["42", 2]);
      await verify?.();
      return { profileId, displayName: "P2", account: { loggedIn: true, deviceBound: false, roles: [] }, todaySchedule: null, missions: { balance: 0, items: [] } };
    },
  };
  let web = createMiyousheWeb(options);
  try {
    const run = (context: MessageFallbackContext) => web.commands.fallback!(command, context);
    expect(await run(message({ message_type: "group", group_id: 77 }))).toContain("请私聊");
    expect(await run(message({ privateCredentialSignal: undefined }))).toContain("好友私聊");
    expect(verified).toEqual([]);
    const reply = await run(message());
    const token = /#ticket=([\w-]{43})/u.exec(String(reply))?.[1];
    expect(token).toBeString();
    expect((await web.handle(claim(token!, "https://wrong.example.org")))?.status).toBe(403);
    const attempts = await Promise.all([web.handle(claim(token!)), web.handle(claim(token!))]);
    expect(attempts.map(result => result?.status).sort()).toEqual([204, 401]);
    const header = attempts.find(result => result?.status === 204)?.headers.get("Set-Cookie");
    expect(header).toContain("HttpOnly; SameSite=Strict; Max-Age=28800; Secure");
    const cookie = header!.split(";", 1)[0]!;
    const disk = await Bun.file(databasePath).arrayBuffer();
    expect(Buffer.from(disk).includes(token!)).toBe(false);
    expect(Buffer.from(disk).includes(cookie.slice(cookie.indexOf("=") + 1))).toBe(false);
    web.close();
    web = createMiyousheWeb(options);
    expect((await web.handle(read(cookie, "same-site")))?.status).toBe(403);
    const response = await web.handle(read(cookie));
    expect(await response?.json()).toMatchObject({ profileId: 2, missions: { balance: 0 } });
    account = "different-login";
    expect((await web.handle(read(cookie)))?.status).toBe(401);
    account = "first-login";
    expect((await web.handle(read(cookie)))?.status).toBe(401);
    const next = /#ticket=([\w-]{43})/u.exec(String(await run(message())))?.[1];
    now += 600_000;
    expect((await web.handle(claim(next!)))?.status).toBe(401);
  } finally {
    web.close();
    await rm(root, { recursive: true, force: true });
  }
});
