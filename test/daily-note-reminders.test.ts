import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMilkyWebhook } from "../lib/adapters/milky-webhook.ts";
import type { MilkyTransportOptions } from "../lib/adapters/milky-session.ts";
import { createDailyNoteReminders } from "../lib/daily-note-reminders.ts";
import type { MessageFallbackContext } from "../lib/commands.ts";

test("三游戏只向有效订阅群提醒，同档角色隔离，冷却持久且未知不重发", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-note-reminder-"));
  const file = join(directory, "reminders.sqlite");
  const life = new AbortController();
  let active = new AbortController();
  let at = 2_000;
  let allowed = true;
  let member = true;
  let changed = false;
  let sendMode = 503;
  const online = Promise.withResolvers<Parameters<NonNullable<MilkyTransportOptions["onOnline"]>>>();
  const sent: { group_id: number; message: unknown }[] = [];
  const reads: string[] = [];
  const gs = { uid: "100001234", region: "cn_gf01", game_biz: "hk4e_cn" };
  const sr = { uid: "500001234", region: "prod_qd_cn", game_biz: "hkrpg_cn" };
  const zzz = { uid: "12345678", region: "prod_gf_cn", game_biz: "nap_cn" };
  const profile = (qq: number, account: number, roles = { gs: [gs], sr: [sr], zzz: [zzz] }) => writeFile(join(directory, `${qq}-2.yaml`),
    Bun.YAML.stringify({ user: { qq: String(qq) }, profile: { id: 2 }, account: {
      cookie: `account_id=${account};cookie_token=fixture`, stuid: String(account), ltuid: String(account), stoken: "fixture-login",
      game_roles: roles,
    } }));
  const ok = (data: object) => Response.json({ retcode: 0, status: "ok", data });
  const credential = "milky-reminders-only-fixture";
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const action = new URL(request.url).pathname.slice(5);
    if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${credential}`) return new Response(null, { status: 401 });
    const body = await request.json() as { group_id: number; user_id: number; message: unknown };
    if (action === "get_login_info") return ok({ uin: 99 });
    if (action === "get_group_member_info" && member) return ok({ member: { group_id: body.group_id, user_id: body.user_id } });
    if (action !== "send_group_message") return new Response(null, { status: 404 });
    sent.push(body);
    return sendMode === 503 ? new Response(null, { status: 503 }) : ok({ message_seq: sent.length });
  } });
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    expect(request.method).toBe("GET");
    expect(request.headers.get("cookie")).toBe("account_id=882;cookie_token=fixture");
    const uid = url.searchParams.get("role_id");
    reads.push(uid ?? "");
    if (uid === gs.uid && changed) await profile(42, 883);
    const stamina = uid === gs.uid ? { current_resin: 160, max_resin: 200, current_home_coin: 891, max_home_coin: 1000 }
      : uid === sr.uid ? { current_stamina: 259, max_stamina: 300 } : { energy: { progress: { current: 211, max: 240 } } };
    return ok({ role_id: uid, server: url.searchParams.get("server"), ...stamina });
  } });
  const eventUrl = new URL("event", gateway.url);
  eventUrl.protocol = "ws:";
  const webhook = createMilkyWebhook({
    apiBase: new URL("api/", gateway.url), eventUrl, connection: "webhook", webhookPath: "/milky",
    accessToken: credential, reconnectMs: 20, heartbeatMs: 1_000, timeoutMs: 2_000,
  }, { signal: life.signal, async dispatch() {}, onOnline(...session) { online.resolve(session); } });
  const settings = (enabled: boolean, transports: Parameters<typeof createDailyNoteReminders>[0]["transports"]) => createDailyNoteReminders({
    directory, file, signal: life.signal, enabled, activeSignal: () => active.signal, allowed: () => allowed, transports,
    async transport(url, init) {
      expect(url.origin).toBe("https://api-takumi-record.mihoyo.com");
      const response = await fetch(new URL(url.pathname + url.search, upstream.url), init);
      return new Response(response.body, { status: response.status, headers: response.headers });
    },
    now: () => at,
  });
  const runtimes: ReturnType<typeof settings>[] = [];
  function open(enabled: boolean, transports: Parameters<typeof settings>[1]) {
    const runtime = settings(enabled, transports);
    runtimes.push(runtime);
    return runtime;
  }
  try {
    await profile(42, 882);
    await profile(43, 884, { gs: [], sr: [], zzz: [] });
    webhook.start();
    const [botId, , , gateway] = await online.promise;
    const disabled = open(false, () => [{ botId, ...gateway }]);
    let reminders = open(true, () => [{ botId, ...gateway }]);
    const context = (normalizedMessage: string, overrides: Partial<MessageFallbackContext> = {}): MessageFallbackContext => ({
      normalizedMessage, user_id: 42, group_id: 77, self_id: 99, adapter: "milky", message_type: "group",
      isMaster: false, isBotMaster: () => false, reply: () => true, ...overrides,
    });
    const command = (raw: string, overrides?: Partial<MessageFallbackContext>, runtime = reminders) =>
      runtime.commands.fallback!(raw, context(raw, overrides));
    expect(await command("#开启体力推送", undefined, disabled)).toContain("未开启");
    expect(await command("#开启体力推送", { message_type: "private" })).toContain("群里");
    expect(await command("#开启体力推送", { isDelegated: true })).toContain("群里");
    expect(await command(`#开启体力推送${gs.uid}`, { user_id: 43 })).toContain("扫码登录");
    await reminders.runDue();
    expect(reads).toEqual([]);
    expect(sent).toEqual([]);
    expect(await command(`#原神开启体力推送${gs.uid} 档案2`)).toContain("阈值 160");
    expect(await command("#星铁开启体力推送")).toContain("阈值 260");
    expect(await command("#绝区零开启体力推送")).toContain("阈值 200");
    expect(await command("#星铁体力推送阈值149")).toContain("不能小于 150");
    expect(await command("#原神开启体力推送", { group_id: 78 })).toContain("阈值 160");
    allowed = false;
    await reminders.runDue();
    expect(reads).toEqual([]);
    allowed = true;
    await reminders.runDue();
    expect(reads.sort()).toEqual([gs.uid, sr.uid, zzz.uid].sort());
    expect(sent.map(item => item.group_id)).toEqual([77, 77, 78]);
    expect(JSON.stringify(sent)).toContain("原神树脂已达到提醒阈值（160/200）");
    expect(JSON.stringify(sent)).toContain("绝区零电量已达到提醒阈值（211/240）");
    expect(JSON.stringify(sent)).toContain('"user_id":42');
    expect(JSON.stringify(sent)).not.toMatch(/891|500001234|12345678|fixture|开拓力/);
    await reminders.stop();
    reminders = open(true, () => [{ botId, ...gateway }]);
    await reminders.runDue();
    expect(sent).toHaveLength(3);
    sendMode = 200;
    expect(await command("#星铁体力推送259")).toContain("已设为 259");
    await reminders.runDue();
    expect(JSON.stringify(sent[3])).toContain("星铁开拓力已达到提醒阈值（259/300）");
    at += 12 * 60 * 60_000;
    active.abort();
    await reminders.runDue();
    expect(sent).toHaveLength(4);
    active = new AbortController();
    member = false;
    await reminders.runDue();
    expect(sent).toHaveLength(4);
    member = true;
    expect(await command("#星铁关闭体力推送")).toContain("已关闭");
    expect(await command("#绝区零关闭体力推送")).toContain("已关闭");
    const contender = open(true, () => [{ botId, ...gateway }]);
    await Promise.all([reminders.runDue(), contender.runDue()]);
    expect(sent.slice(4).map(item => item.group_id).sort()).toEqual([77, 78]);
    at += 12 * 60 * 60_000;
    changed = true;
    await reminders.runDue();
    expect(sent).toHaveLength(6);
    const before = reads.length;
    await reminders.runDue();
    expect(reads).toHaveLength(before);
  } finally {
    life.abort();
    await Promise.all(runtimes.map(runtime => runtime.stop()));
    await Promise.all([gateway.stop(true), upstream.stop(true)]);
    await rm(directory, { recursive: true, force: true });
  }
});
