import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { panelApi } from "../lib/panel.ts";
import { createPanelOwnerSession } from "../lib/panel-owner-session.ts";
import { ownerContactListSession, type OwnerContactListSession } from "../lib/owner-contact-list.ts";
import { CommandRegistry } from "../lib/commands.ts";

test("owner tickets are private, one-use, expiring and scoped to a current owner across a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-owner-"));
  const databasePath = join(dir, "panel.sqlite");
  const lifecycle = new AbortController();
  let time = 10_000;
  let owner = true;
  const options = {
    databasePath,
    config: { panel_ticket_minutes: 2, panel_session_hours: 1 },
    signal: lifecycle.signal,
    publicBase: () => new URL("https://panel.test/robot/"),
    isOwner: (bot: number, user: number) => bot === 202 && user === 303 && owner,
    now: () => time,
  };
  let session = createPanelOwnerSession(options);
  const context = {
    self_id: 202, user_id: 303, message_type: "private" as const, privateCredentialSignal: lifecycle.signal,
    isMaster: true, isBotMaster: (id: number) => options.isOwner(202, id), normalizedMessage: "#管理面板",
    reply: async () => true,
  };
  const issue = (overrides = {}) => session.commands.fallback?.("#管理面板", { ...context, ...overrides });
  const path = "/panel/api/session/";
  const headers = {
    "Content-Type": "application/json", "X-Lotus-Panel-Session": "1",
    "Origin": "https://panel.test", "Sec-Fetch-Site": "same-origin",
  };
  const request = (part: string, body: unknown, extra = {}) => new Request(`http://127.0.0.1:4444${path}${part}`, {
    method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body),
  });
  const ticket = async () => {
    const result = await issue();
    expect(typeof result).toBe("string");
    const link = new URL(String(result).split("\n")[1]!);
    expect(link.pathname).toBe("/robot/panel/");
    expect(link.search).toBe("");
    return new URLSearchParams(link.hash.slice(1)).get("ticket");
  };
  try {
    expect(await issue({ message_type: "group" })).toContain("私聊");
    expect(await issue({ privateCredentialSignal: undefined })).toContain("好友");
    expect(await issue({ self_id: 222 })).toContain("主人");
    expect(await issue({ isDelegated: true })).toBeUndefined();
    const expired = await ticket();
    time += 120_000;
    const first = await ticket();
    expect((await session.handle(request("claim", { ticket: expired }), path + "claim"))?.status).toBe(401);
    expect((await session.handle(request("claim", { ticket: first }, { Origin: "https://elsewhere.test" }), path + "claim"))?.status).toBe(403);
    expect((await session.handle(request("claim", { ticket: first }, { "X-Lotus-Panel-Session": "" }), path + "claim"))?.status).toBe(403);
    const results = await Promise.all(Array.from({ length: 2 }, () =>
      session.handle(request("claim", { ticket: first }), path + "claim")));
    expect(results.map(result => result?.status).sort()).toEqual([204, 401]);
    const setCookie = results.find(result => result?.status === 204)?.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/; Path=\/robot\/panel\/; HttpOnly; SameSite=Strict; Max-Age=3600; Secure$/u);
    const cookie = setCookie.split(";", 1)[0]!;
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    const sqlite = new Database(databasePath, { readonly: true });
    try {
      expect(sqlite.query("SELECT hash FROM credentials").values().flat().every(value => /^[a-f\d]{64}$/u.test(String(value)))).toBe(true);
    } finally { sqlite.close(); }

    session.close();
    session = createPanelOwnerSession(options);
    const api = panelApi("static-test-token", [], candidate => candidate === "/panel/api/write"
      ? () => new Response(null, { status: 204 }) : undefined, undefined, session);
    const business = (suffix: string, extra: RequestInit = {}) => api(new Request(`http://127.0.0.1:4444/panel/api/${suffix}`, extra));
    expect((await business("status", { headers: { Cookie: cookie } }))?.status).toBe(200);
    const readSession = (key: string, extra: HeadersInit = {}) => business("session/current", {
      headers: { Cookie: key, "X-Lotus-Panel-Session": "1", ...extra },
    });
    const info = await readSession(cookie);
    expect(info?.status).toBe(200);
    expect(info?.headers.get("Cache-Control")).toBe("no-store");
    expect(await info?.json()).toEqual({ expiresAt: time + 3_600_000, now: time });
    time += 4_000;
    expect(await (await readSession(cookie))?.json()).toEqual({ expiresAt: time + 3_596_000, now: time });
    expect((await readSession(cookie, { "Sec-Fetch-Site": "cross-site" }))?.status).toBe(403);
    expect((await business("session/current", { headers: { Cookie: cookie } }))?.status).toBe(403);
    expect((await readSession(cookie, { Authorization: "Bearer static-test-token" }))?.status).toBe(401);

    expect((await business("status", { headers: { Cookie: `${cookie}; ${cookie}` } }))?.status).toBe(401);
    expect((await business("status", { headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" } }))?.status).toBe(401);
    expect((await business("status", { headers: { Authorization: "Bearer wrong", Cookie: cookie } }))?.status).toBe(401);
    expect((await business("write", { method: "POST", headers: { Cookie: cookie } }))?.status).toBe(401);
    expect((await business("write", { method: "POST", headers: { ...headers, Cookie: cookie } }))?.status).toBe(204);
    expect((await business("write", { method: "POST", headers: { Authorization: "Bearer static-test-token" } }))?.status).toBe(204);
    const second = await ticket();
    owner = false;
    expect((await business("status", { headers: { Cookie: cookie } }))?.status).toBe(401);
    expect((await api(request("claim", { ticket: second })))?.status).toBe(401);
    owner = true;
    expect((await business("status", { headers: { Cookie: cookie } }))?.status).toBe(401);
    expect((await api(request("claim", { ticket: second })))?.status).toBe(401);
    const third = await ticket();
    const thirdCookie = (await api(request("claim", { ticket: third })))?.headers.get("Set-Cookie")?.split(";", 1)[0];
    expect(thirdCookie).toBeDefined();
    expect((await api(request("logout", {}, { Cookie: thirdCookie })))?.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await business("status", { headers: { Cookie: thirdCookie! } }))?.status).toBe(401);
    const fourth = await ticket();
    const fourthCookie = (await api(request("claim", { ticket: fourth })))?.headers.get("Set-Cookie")?.split(";", 1)[0];
    expect(fourthCookie).toBeDefined();
    time += 3_600_000;
    expect((await readSession(fourthCookie!))?.status).toBe(401);
    expect((await business("status", { headers: { Cookie: fourthCookie! } }))?.status).toBe(401);
  } finally {
    lifecycle.abort();
    session.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("锅巴群友搜索只使用登录时绑定的私聊网关，断线、退出和撤销权限后立即失效", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-guoba-contacts-"));
  const lifecycle = new AbortController();
  const originalConnection = new AbortController();
  let allowed = true;
  let connected = true;
  let reads = 0;
  const gateway: OwnerContactListSession = {
    botId: 202, ownerId: 303, signal: originalConnection.signal, authorized: () => connected,
    async groups() {
      reads += 1;
      return Array.from({ length: 32 }, (_, index) => ({ id: 400 + index, name: "测试小组 " + index }));
    },
    async friends() {
      reads += 1;
      return [{ user_id: "605", nickname: "旧友", private_details: "无权读取" }];
    },
    async reply() { return "rejected"; },
    async forward() { return "rejected"; },
  };
  const session = createPanelOwnerSession({
    databasePath: join(dir, "panel.sqlite"), config: {}, signal: lifecycle.signal, publicBase: () => new URL("https://panel.test/"),
    isOwner: (bot, user) => allowed && bot === 202 && user === 303,
  });
  const api = panelApi("static-test-token", [], undefined, undefined, session);
  const commands = new CommandRegistry();
  let leaked: OwnerContactListSession | undefined;
  commands.registerModule({
    name: "unrelated-plugin", commands: {},
    fallback(_message, context) { leaked = context[ownerContactListSession]; },
  });
  commands.registerModule(session.commands);
  const request = (part: string, body: unknown, extra?: HeadersInit) => {
    const headers = new Headers(extra);
    headers.set("Content-Type", "application/json");
    headers.set("X-Lotus-Panel-Session", "1");
    if (!headers.has("Origin")) headers.set("Origin", "https://panel.test");
    return api(new Request("https://panel.test/panel/api/session/" + part, {
      method: "POST", headers, body: JSON.stringify(body),
    }));
  };
  const login = async (sessionGateway = gateway) => {
    const issued = await commands.dispatchFallback({
      msg: "#管理面板", raw_message: "#管理面板", message: "#管理面板", post_type: "message", isGroup: false, isPrivate: true,
      self_id: 202, user_id: 303, message_type: "private", privateCredentialSignal: lifecycle.signal,
      isMaster: true, reply: async () => true,
      [ownerContactListSession]: sessionGateway,
    }, () => true, () => true);
    expect(leaked).toBeUndefined();
    const ticket = new URLSearchParams(new URL(String(issued).split("\n")[1]!).hash.slice(1)).get("ticket");
    const claimed = await request("claim", { ticket });
    expect(claimed?.status).toBe(204);
    return claimed!.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  };
  const search = (kind = "friend", query = "", page = 1, headers?: HeadersInit) =>
    request("contacts", { kind, query, page }, headers);
  try {
    const wrong = await login({ ...gateway, botId: 999 });
    expect((await search("friend", "", 1, { Cookie: wrong }))?.status).toBe(403);
    expect((await search("friend", "", 1, { Authorization: "Bearer static-test-token" }))?.status).toBe(403);
    const cookie = await login();
    expect((await search("friend", "", 1, { Cookie: cookie, Origin: "https://other.test" }))?.status).toBe(403);
    expect((await search("friend", "", 1, { Cookie: cookie, Authorization: "Bearer static-test-token" }))?.status).toBe(403);
    expect((await search("invalid", "", 1, { Cookie: cookie }))?.status).toBe(400);
    expect(reads).toBe(0);
    const friend = await search("friend", "旧", 1, { Cookie: cookie });
    expect(friend?.headers.get("Cache-Control")).toBe("no-store");
    expect(await friend?.json()).toEqual({ items: [{ id: 605, name: "旧友" }], next: false });
    const first = await search("group", "测试", 1, { Cookie: cookie });
    expect(await first?.json()).toMatchObject({ next: true });
    const later = await search("group", "测试", 2, { Cookie: cookie });
    expect(await later?.json()).toEqual({ items: [{ id: 430, name: "测试小组 30" }, { id: 431, name: "测试小组 31" }], next: false });
    connected = false;
    expect((await search("friend", "", 1, { Cookie: cookie }))?.status).toBe(403);
    connected = true;
    const another = await login();
    await request("logout", {}, { Cookie: another });
    expect((await search("friend", "", 1, { Cookie: another }))?.status).toBe(403);
    allowed = false;
    expect((await search("friend", "", 1, { Cookie: cookie }))?.status).toBe(403);
    allowed = true;
    const fresh = await login();
    originalConnection.abort();
    expect((await search("friend", "", 1, { Cookie: fresh }))?.status).toBe(403);
    expect(reads).toBe(3);
  } finally {
    lifecycle.abort();
    session.close();
    await rm(dir, { recursive: true, force: true });
  }
});
