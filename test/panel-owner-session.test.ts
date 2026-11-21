import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { panelApi } from "../lib/panel.ts";
import { createPanelOwnerSession } from "../lib/panel-owner-session.ts";

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
    expect((await business("status", { headers: { Cookie: fourthCookie! } }))?.status).toBe(401);
  } finally {
    lifecycle.abort();
    session.close();
    await rm(dir, { recursive: true, force: true });
  }
});
