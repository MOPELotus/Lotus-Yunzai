import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "@lotus-yunzai/account";
import { submitMiyousheShopExchange } from "@lotus-yunzai/hoyo-client/miyoushe-exchange";
import { createManualCaptchaRelay } from "../lib/captcha/manual-relay.ts";
import type { MessageFallbackContext } from "../lib/commands.ts";
import { createMiyousheOverview, type MiyousheOverviewTarget } from "../lib/miyoushe-overview.ts";
import { createMiyousheShopCatalog } from "../lib/miyoushe-shop-catalog.ts";
import { createMiyousheShopPlans, type MiyousheShopReceiptRoute } from "../lib/miyoushe-shop-plans.ts";
import { createMiyousheWeb, miyousheWebSettings } from "../lib/miyoushe-web.ts";

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

test("网页登录票据在重启后保留签发机器人及协议，浏览器只能确认订单", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-miyoushe-shop-receipt-"));
  const profiles = createProfileStore(root);
  const role = { uid: "1000042", region: "cn_gf01" };
  const received: Array<{ qq: string; route: MiyousheShopReceiptRoute; message: string }> = [];
  let submissions = 0;
  const plans = createMiyousheShopPlans({ file: join(root, "plans.json"), profileDirectory: root,
    async inspect(_target, id) {
      return { good: { id, name: "合成商品", gameBiz: "hk4e_cn", price: 300, type: 2, status: "available", opensAt: null },
        balance: 999, roles: [role] };
    },
    async submit() { submissions++; return "succeeded"; },
    async receiptRoute(qq, route) {
      return async message => { received.push({ qq, route, message }); };
    },
  });
  const options = { publicBase: () => origin, databasePath: join(root, "auth.sqlite"), assetDirectory: root,
    signal: new AbortController().signal, loginIdentity: profiles.loginIdentity, plans,
    async overview(): Promise<never> { throw new Error("隔离测试仅使用商城"); },
  };
  let web = createMiyousheWeb(options);
  try {
    await writeFile(join(root, "42-2.yaml"), Bun.YAML.stringify({
      user: { qq: "42" }, profile: { id: 2 }, account: { stuid: "27", ltuid: "27", stoken: "fixture", cookie: "account_id=27;cookie_token=fixture" },
      device: { id: "fixture-device", fp: "fixture-fingerprint" },
    }));
    for (const [index, adapter] of ([undefined, "milky"] as const).entries()) {
      const issued = await web.commands.fallback!(command, message({ adapter }));
      const ticket = /#ticket=([\w-]{43})/u.exec(String(issued))?.[1];
      expect(ticket).toBeString();
      web.close();
      web = createMiyousheWeb(options);
      const login = await web.handle(claim(ticket!));
      expect(login?.status).toBe(204);
      const cookie = login!.headers.get("Set-Cookie")!.split(";", 1)[0]!;
      if (index === 0) {
        const history = (search: string) => web.handle(request(`api/plans?${search}`, { headers: { Cookie: cookie } }));
        expect((await history("before=broken"))?.status).toBe(400);
        expect((await history("before=1.111111111111&before=2.222222222222"))?.status).toBe(400);
        expect((await history("before=1.111111111111&qq=9"))?.status).toBe(400);
        expect(await (await history("before=1.111111111111"))?.json()).toMatchObject({ plans: [] });
      }
      const order = { ...role, confirmed: true, goodsId: String(271 + index), immediate: true, expectedPrice: 300 };
      const post = (body: object) => web.handle(request("api/plans", { method: "POST",
        headers: { Origin: origin.origin, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      expect((await post({ ...order, receiptRoute: "milky:77" }))?.status).toBe(400);
      const result = await post(order);
      expect(result?.status).toBe(200);
      expect(await result?.json()).not.toHaveProperty("receiptRoute");
      await plans.scan();
      expect(received[index]).toMatchObject({ qq: "42", route: { adapter: adapter ?? "onebot", botId: 99 },
        message: expect.stringContaining("兑换成功") });
    }
    expect(submissions).toBe(2);
    expect(received).toHaveLength(2);
  } finally {
    web.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("米游社网页按原脚本地址提供 Bun 转译后的浏览器资源，不公开 TypeScript 源文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-miyoushe-browser-script-"));
  const account = createProfileStore(root);
  const site = createMiyousheWeb({ publicBase: () => origin, databasePath: join(root, "auth.sqlite"),
    assetDirectory: root, signal: new AbortController().signal, loginIdentity: account.loginIdentity,
    async overview() { throw new Error("脚本请求不读取账号。"); },
  });
  try {
    await writeFile(join(root, "app.ts"), 'const version: number = 42; document.body.dataset.version = String(version);');
    const response = await site.handle(request("app.js"));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    const text = await response?.text();
    expect(text).toContain("document.body.dataset.version");
    expect(text).not.toContain(": number");
    const head = await site.handle(request("app.js", { method: "HEAD" }));
    expect(head?.status).toBe(200);
    expect(await head?.text()).toBe("");
    expect((await site.handle(request("app.ts")))?.status).toBe(404);
  } finally {
    site.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("已登录浏览器即时兑换只能在同一会话查看和续交人工验证码", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-miyoushe-shop-manual-"));
  const controller = new AbortController();
  const relay = createManualCaptchaRelay({ publicUrl: origin.origin });
  const store = createProfileStore(root);
  const good = { id: "27", name: "隔离商品", gameBiz: "hk4e_cn", price: 300, type: 2, status: "available", opensAt: null } as const;
  const role = { uid: "1000042", region: "cn_gf01" };
  let firstPost = 0;
  let secondPost = 0;
  let time = Date.now();
  let endsAt: number | undefined;
  let saleStartsAt: number | undefined;
  const planOptions = {
    file: join(root, "plans.json"), profileDirectory: root, manualRelay: () => relay, now: () => time,
    async inspect() {
      return { good: { ...good, endsAt, saleStartsAt, limitCycle: "not_limit", serverNow: time }, balance: 999, roles: [role] };
    },
  };
  const plans = createMiyousheShopPlans({
    ...planOptions,
    async submit(plan, signal, verify, manual) {
      return submitMiyousheShopExchange(async (url, init) => {
        const headers = new Headers(init.headers);
        if (url.pathname.endsWith("/goods/exchange")) {
          if (!headers.has("x-rpc-challenge")) { firstPost++; return Response.json({ retcode: 1028 }); }
          secondPost++;
          expect(headers.get("x-rpc-challenge")).toBe("approved-by-fake-shop");
          return Response.json({ retcode: 0 });
        }
        if (url.pathname.endsWith("/createVerification")) return Response.json({ retcode: 0, data: { captcha_id: "fixture" } });
        return Response.json({ retcode: 0, data: { challenge: "approved-by-fake-shop" } });
      }, await store.accountContext(plan.qq, plan.profileId), plan, signal, verify, manual);
    },
  });
  const web = createMiyousheWeb({
    publicBase: () => origin, databasePath: join(root, "auth.sqlite"), assetDirectory: "web/miyoushe", signal: controller.signal,
    loginIdentity: store.loginIdentity, plans,
    async overview() { throw new Error("本夹具不读取任务概况"); },
  });
  function browse(cookie: string, route: string, body?: object) {
    return web.handle(request(route, { headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin",
      ...(body && { Origin: origin.origin, "Content-Type": "application/json" }) },
      ...(body && { method: "POST", body: JSON.stringify(body) }) }));
  }
  async function login() {
    const reply = await web.commands.fallback!(command, message());
    const token = /#ticket=([\w-]{43})/u.exec(String(reply))?.[1];
    expect(token).toBeString();
    const response = await web.handle(claim(token!));
    expect(response?.status).toBe(204);
    return response!.headers.get("Set-Cookie")!.split(";")[0]!;
  }
  async function manualLink(cookie: string) {
    for (let n = 0; n < 100; n++) {
      const response = await browse(cookie, "api/plans");
      expect(response?.status).toBe(200);
      const data = await response!.json();
      const link = data.plans.find((plan: { verification?: unknown }) => plan.verification)?.verification.link;
      if (typeof link === "string") return link;
      await Bun.sleep(15);
    }
    throw new Error("没有收到人工验证票据");
  }
  const accept = { captchaVersion: 4, captchaId: "fixture", lotNumber: "fixture-lot", captchaOutput: "fixture-output",
    passToken: "fixture-pass", genTime: "1760000000" };
  async function postProof(link: string) {
    const validate = new URL(link);
    validate.pathname = validate.pathname.replace("/GTest/", "/GTest/validate/");
    return relay.handlePublic(new Request(validate, { method: "POST", headers: { Origin: origin.origin, "Content-Type": "application/json" },
      body: JSON.stringify(accept) }));
  }
  try {
    await writeFile(join(root, "42-2.yaml"), Bun.YAML.stringify({
      version: 1, user: { qq: "42" }, profile: { id: 2 },
      account: { stuid: "123", ltuid: "123", stoken: "v2_fixture", mid: "fixture-mid", updated_at: "2026-01-01",
        cookie: "cookie_token=fixture;account_id=123" },
      device: { id: "fixture-id", fp: "fixture-fp" },
    }));
    const owner = await login();
    const otherBrowser = await login();
    const order = { goodsId: good.id, expectedPrice: good.price, immediate: true, confirmed: true, ...role, intentId: crypto.randomUUID() };
    const submitted = await browse(owner, "api/plans", order);
    expect(submitted?.status).toBe(200);
    const original = await submitted!.json();
    const running = plans.scan(controller.signal);
    const link = await manualLink(owner);
    const foreign = await (await browse(otherBrowser, "api/plans"))!.json();
    expect(foreign.plans.find((plan: { id: string }) => plan.id === original.id)).not.toHaveProperty("verification");
    const retried = await (await browse(otherBrowser, "api/plans", order))!.json();
    expect(retried).toMatchObject({ id: original.id });
    const uri = new URL(link);
    uri.pathname = uri.pathname.replace("/GTest/", "/GTest/register/");
    expect((await relay.handlePublic(new Request(uri)))?.status).toBe(200);
    expect((await postProof(link))?.status).toBe(200);
    await running;
    expect([firstPost, secondPost]).toEqual([1, 1]);
    expect((await (await browse(owner, "api/plans"))!.json()).plans[0]).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(await readFile(planOptions.file, "utf8")).not.toContain(link);

    expect((await browse(owner, "api/plans", { ...order, intentId: crypto.randomUUID() }))?.status).toBe(200);
    const logoutRun = plans.scan(controller.signal);
    const revoked = await manualLink(owner);
    expect((await browse(owner, "api/logout", {}))?.status).toBe(204);
    expect((await postProof(revoked))?.status).toBe(404);
    await logoutRun;
    expect([firstPost, secondPost]).toEqual([2, 1]);
    expect((await browse(owner, "api/plans"))?.status).toBe(401);

    endsAt = time + 2_000;
    expect((await browse(otherBrowser, "api/plans", { ...order, intentId: crypto.randomUUID() }))?.status).toBe(200);
    const closingRun = plans.scan(controller.signal);
    const closing = await manualLink(otherBrowser);
    const closingClaim = new URL(closing);
    closingClaim.pathname = closingClaim.pathname.replace("/GTest/", "/GTest/register/");
    expect((await relay.handlePublic(new Request(closingClaim)))?.status).toBe(200);
    time += 2_000;
    expect((await postProof(closing))?.status).toBe(200);
    await closingRun;
    expect([firstPost, secondPost]).toEqual([3, 1]);
    expect((await (await browse(otherBrowser, "api/plans"))!.json()).plans.every((plan: { verification?: unknown }) => !plan.verification))
      .toBe(true);

    endsAt = undefined;
    saleStartsAt = time - 2_000;
    expect((await browse(otherBrowser, "api/plans", { ...order, intentId: crypto.randomUUID() }))?.status).toBe(200);
    const rotatedRun = plans.scan(controller.signal);
    const rotated = await manualLink(otherBrowser);
    const rotatedClaim = new URL(rotated);
    rotatedClaim.pathname = rotatedClaim.pathname.replace("/GTest/", "/GTest/register/");
    expect((await relay.handlePublic(new Request(rotatedClaim)))?.status).toBe(200);
    saleStartsAt = time - 1_000;
    expect((await postProof(rotated))?.status).toBe(200);
    await rotatedRun;
    expect([firstPost, secondPost]).toEqual([4, 1]);
    expect((await (await browse(otherBrowser, "api/plans"))!.json()).plans[0]).toMatchObject({ status: "failed", attempts: 1 });
  } finally {
    controller.abort();
    relay.close();
    web.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("米游社网页沿用旧挂载地址、开关和网页登录有效期", () => {
  const settings = miyousheWebSettings({ enable: false, path: "/lotus/coin-shop/", public_url: "https://miyoushe.example.org/lotus/coin-shop/",
    ticket_minutes: 2, session_hours: 0.5 });
  expect(settings).toMatchObject({ enabled: false, path: "/lotus/coin-shop", ticketMinutes: 2, sessionHours: 0.5 });
  expect(settings.origin?.href).toBe("https://miyoushe.example.org/");
  expect(miyousheWebSettings({ path: "/panel/account", public_url: "file:///tmp/shop" })).toMatchObject({ path: undefined, origin: undefined });
  expect(miyousheWebSettings({ path: "/MEDIA/cards", public_url: "https://miyoushe.example.org/exit/session" }).path).toBeUndefined();
  expect(miyousheWebSettings({ path: "/Shared" }, "/shared/events")).toMatchObject({ path: "/miyoushe", mountConflict: true });
  expect(miyousheWebSettings({}, "/miyoushe/events")).toMatchObject({ path: "/lotus-miyoushe", mountConflict: true });
  expect(miyousheWebSettings({ path: "/shared-shop" }, "/shared/events")).toMatchObject({ path: "/shared-shop", mountConflict: false });
});

test("米游社浏览器票只从绑定好友获取，一次兑换并绑定档案，会话重启后可用", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-miyoushe-web-"));
  const databasePath = join(root, "auth.sqlite");
  const verified: unknown[] = [];
  let now = 1_000;
  let account = "first-login";
  const options = {
    publicBase: () => origin, databasePath, assetDirectory: "web/miyoushe", signal: new AbortController().signal,
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

test("商城待确认结果仅允许当前登录的原米游社账号核对，包括无设备确认印的历史记录", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-shop-resolve-account-"));
  const file = join(root, "plans.json");
  const profile = (id: string, cookieId = id, fingerprint = "initial-device") => writeFile(join(root, "42-2.yaml"), Bun.YAML.stringify({
    user: { qq: "42" }, profile: { id: 2 }, account: {
      stuid: id, ltuid: id, cookie: `account_id=${cookieId};cookie_token=fixture`, stoken: "fixture",
    }, device: { id: "fixture-id", fp: fingerprint },
  }));
  const target = { qq: "42", profileId: 2 };
  const oldId = "abcdef000001", modernId = "abcdef000002";
  const now = Date.now();
  const legacy = { ...target, id: oldId, accountId: "27", botId: "", goodsId: "44", goodsName: "合成商品",
    gameBiz: "hk4e_cn", type: 2, price: 20, role: null, addressId: "", addressLabel: "", immediate: true,
    createdAt: now, opensAt: now, attempts: 1, status: "unknown", message: "测试旧回执" };
  const profiles = createProfileStore(root);
  let outward = 0;
  const plans = createMiyousheShopPlans({ file, profileDirectory: root,
    async inspect() { outward++; throw new Error("人工确认不请求商城"); },
    async submit() { outward++; throw new Error("人工确认不提交购物"); },
  });
  const controller = new AbortController();
  const web = createMiyousheWeb({
    publicBase: () => origin, databasePath: join(root, "auth.sqlite"), assetDirectory: "web/miyoushe", signal: controller.signal,
    loginIdentity: profiles.loginIdentity, plans, async overview() { throw new Error("测试不读取概况"); },
  });
  async function login() {
    const reply = await web.commands.fallback!(command, message());
    const ticket = /#ticket=([\w-]{43})/u.exec(String(reply))?.[1];
    expect(ticket).toBeString();
    const response = await web.handle(claim(ticket!));
    expect(response?.status).toBe(204);
    return response!.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  }
  const resolve = (cookie: string, id: string, redeemed: boolean) =>
    web.handle(request(`api/plans/${id}/resolve`, { method: "POST",
      headers: { Origin: origin.origin, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ redeemed }) }));
  try {
    await profile("27");
    const original = JSON.stringify({ version: 2, plans: [legacy, { ...legacy, id: modernId, bindingStamp: "a".repeat(64) }], trackers: [] });
    await writeFile(file, original);
    const oldSession = await login();
    await profile("88");
    expect((await resolve(oldSession, oldId, false))?.status).toBe(401);
    const switched = await login();
    const rejection = await resolve(switched, oldId, false);
    expect(rejection?.status).toBe(409);
    expect(await rejection?.json()).toMatchObject({ message: expect.stringContaining("原米游社账号") });
    await expect(plans.resolve(target, modernId, true)).rejects.toMatchObject({ status: 409 });
    expect(await readFile(file, "utf8")).toBe(original);

    await profile("27", "88");
    expect((await resolve(await login(), oldId, false))?.status).toBe(409);
    expect(await readFile(file, "utf8")).toBe(original);

    await profile("27");
    let verifications = 0;
    await expect(plans.resolve(target, modernId, true, async () => {
      if (++verifications === 2) await profile("88");
    })).rejects.toMatchObject({ status: 409 });
    expect(await readFile(file, "utf8")).toBe(original);

    await profile("27", "27", "new-device");
    const restored = await login();
    expect(await (await resolve(restored, oldId, false))?.json()).toMatchObject({ id: oldId, status: "failed" });
    expect(await (await resolve(restored, modernId, true))?.json()).toMatchObject({ id: modernId, status: "succeeded" });
    expect(outward).toBe(0);
  } finally {
    controller.abort();
    web.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("本人社区总览只读现行任务，隐藏官方已下线的任务并保留余额", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-miyoushe-missions-"));
  const profiles = createProfileStore(root);
  const reads: URL[] = [];
  let remainingPoints: number | undefined = 0;
  const web = createMiyousheWeb({
    publicBase: () => origin, databasePath: join(root, "auth.sqlite"), assetDirectory: "web/miyoushe", signal: session.signal,
    loginIdentity: profiles.loginIdentity,
    overview: createMiyousheOverview({ profileDirectory: root, async transport(url, options) {
      expect(options?.method).toBe("GET");
      expect(options?.body).toBeUndefined();
      expect(new Headers(options?.headers).get("Cookie")).toContain("account_id=42");
      reads.push(new URL(url));
      return Response.json({ retcode: 0, data: { total_points: 712, already_received_points: 26,
        today_total_points: 42, can_get_points: remainingPoints, states: [
        { mission_id: 58, happened_times: 1, is_get_award: 1 },
        { mission_id: 59, mission_key: "read_post", happened_times: 0 },
        { mission_id: 60, happened_times: 3 },
        { mission_id: 61, is_get_award: true },
        { mission_id: 410, mission_key: "share_post" },
        { mission_id: 72, mission_key: "bind_game_role_1", happened_times: 0, threshold: 1, is_get_award: 0 },
        { mission_id: 73, mission_key: "modify_signature_2", is_get_award: true },
        { mission_id: 74, mission_key: "<not-an-official-key>" },
      ] } });
    } }),
  });
  try {
    await writeFile(join(root, "42-2.yaml"), Bun.YAML.stringify({
      user: { qq: "42" }, profile: { id: 2 },
      account: { cookie: "account_id=42;cookie_token=fixture", stuid: "42", ltuid: "42", stoken: "fixture-stoken" },
      mihoyobbs: { enable: true, tasks: { checkin: true, read: true, like: true, cancel_like: true, share: true }, checkin_list: [2] },
    }));
    expect((await web.handle(read("")))?.status).toBe(401);
    expect(reads).toHaveLength(0);
    const reply = await web.commands.fallback!(command, message());
    const token = /#ticket=([\w-]{43})/u.exec(String(reply))?.[1];
    expect(token).toBeString();
    const authorization = await web.handle(claim(token!));
    const cookie = authorization!.headers.get("Set-Cookie")!.split(";", 1)[0]!;
    const response = await web.handle(read(cookie));
    expect(response?.status).toBe(200);
    expect((await response!.json()).missions).toEqual({
      balance: 712, received: 26, todayTotal: 42, remaining: 0,
      items: [
        { missionId: 58, label: "社区连续签到", happenedTimes: 1, isGetAward: true },
        { missionId: 72, label: "绑定游戏角色", happenedTimes: 0, threshold: 1, isGetAward: false },
        { missionId: 73, label: "完善个人签名", isGetAward: true },
        { missionId: 74, label: "社区任务 74" },
      ],
    });
    remainingPoints = undefined;
    const unknown = await web.handle(read(cookie));
    expect(unknown?.status).toBe(200);
    expect((await unknown!.json()).missions).not.toHaveProperty("remaining");
    const endpoint = "https://bbs-api.miyoushe.com/apihub/wapi/getUserMissionsState?point_sn=myb";
    expect(reads.map(url => url.href)).toEqual([endpoint, endpoint]);
  } finally {
    web.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("反代剥去公共前缀时，米游社票链接和登录、退出 Cookie 都使用浏览器路径", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-miyoushe-public-path-"));
  const base = new URL("/bots/my%20lotus/", origin);
  const web = createMiyousheWeb({
    publicBase: () => base, databasePath: join(root, "auth.sqlite"), assetDirectory: "web/miyoushe", signal: session.signal,
    async loginIdentity() { return "same-login"; },
    async overview() { throw new Error("测试不读取概况"); },
  });
  try {
    const reply = await web.commands.fallback!(command, message());
    const link = new URL(String(reply).split("\n")[1]!);
    expect(link.origin).toBe(origin.origin);
    expect(link.pathname).toBe("/bots/my%20lotus/miyoushe/");
    const ticket = link.hash.replace(/^#ticket=/u, "");
    const accepted = await web.handle(claim(ticket));
    expect(accepted?.status).toBe(204);
    const cookie = accepted?.headers.get("Set-Cookie");
    expect(cookie).toContain(`Path=${link.pathname};`);
    expect(cookie).toEndWith("; Secure");
    const logout = await web.handle(request("api/logout", {
      method: "POST", headers: { Origin: origin.origin, Cookie: cookie!.split(";", 1)[0]! },
    }));
    expect(logout?.status).toBe(204);
    expect(logout?.headers.get("Set-Cookie")).toContain(`Path=${link.pathname}; HttpOnly; SameSite=Strict; Max-Age=0; Secure`);
  } finally {
    web.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("商城追踪目标只刷新当前档案一次，同一网页会话可读商品，换绑不重试", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-miyoushe-web-roles-"));
  const profiles = createProfileStore(root);
  const filename = join(root, "42-2.yaml");
  const other = join(root, "42.yaml");
  const uid = "1000042";
  const expired = "old-session";
  const refreshed = "ltoken_v2=v2_fresh;ltuid_v2=71;ltmid_v2=login-mid;" +
    "cookie_token_v2=v2_fresh_cookie;account_id_v2=71;account_mid_v2=login-mid;";
  function profile(id: number, aid: string, cookie: string) {
    return Bun.YAML.stringify({ profile: { id }, account: { stuid: aid, stoken: "v2_login", mid: "login-mid",
      updated_at: "2026-11-01", cookie, current_uid: { gs: uid } } });
  }
  const paths: string[] = [];
  let rebind = false;
  const catalog = createMiyousheShopCatalog({ profileDirectory: root, async transport(url, init) {
    const supplied = new Headers(init.headers).get("Cookie");
    if (url.pathname === "/account/ma-cn-session/app/exchange") {
      expect(url.origin).toBe("https://passport-api.mihoyo.com");
      expect(init.method).toBe("POST");
      expect(typeof init.body).toBe("string");
      const { dst_token_type } = JSON.parse(String(init.body));
      expect([2, 4]).toContain(dst_token_type);
      const ltoken = dst_token_type === 2;
      paths.push(ltoken ? "登录令牌" : "会话凭据");
      return Response.json({ retcode: 0, data: { token: { token: ltoken ? "v2_fresh" : "v2_fresh_cookie" },
        user_info: { aid: "71" } } });
    }
    expect(init.method ?? "GET").toBe("GET");
    if (url.pathname.endsWith("/goods/detail")) {
      paths.push("商品");
      expect(supplied).toBeNull();
      return Response.json({ retcode: 0, data: { goods_id: "27", goods_name: "测试商品", price: 100, type: 2, game_biz: "hk4e_cn" } });
    }
    if (url.pathname.endsWith("/getUserGameRolesByCookie")) {
      paths.push("角色");
      if (supplied === expired) {
        if (rebind) await writeFile(filename, profile(2, "72", "rebound"));
        return Response.json({ retcode: -100 });
      }
      expect(supplied).toBe(refreshed);
      return Response.json({ retcode: 0, data: { list: [
        { game_biz: "hk4e_cn", game_uid: uid, region: "cn_gf01" },
        { game_biz: "hk4e_cn", game_uid: "1000043", region: "cn_qd01" },
      ] } });
    }
    throw new Error("unexpected fixture request " + url.pathname);
  } });
  const plans = createMiyousheShopPlans({ file: join(root, "plans.json"), profileDirectory: root,
    async inspect() { throw new Error("读取目标时不检查订单"); },
    tracking: { async catalog() { return []; }, async destinations(target, _game, _itemType, signal, verify) {
      return { roles: await catalog.trackingRoles(target, "hk4e_cn", signal, verify) };
    } },
  });
  const web = createMiyousheWeb({ publicBase: () => origin, databasePath: join(root, "auth.sqlite"),
    assetDirectory: "web/miyoushe", signal: session.signal, loginIdentity: profiles.loginIdentity, catalog, plans,
    async overview() { throw new Error("测试不读取概况"); },
  });
  async function authorize() {
    const reply = await web.commands.fallback!(command, message());
    const ticket = /#ticket=([\w-]{43})/u.exec(String(reply))![1]!;
    const claimed = await web.handle(claim(ticket));
    expect(claimed?.status).toBe(204);
    return claimed!.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  }
  const targets = "api/tracking-targets?game=hk4e&itemType=2";
  try {
    const std = profile(1, "73", "untouched");
    await writeFile(other, std);
    await writeFile(filename, profile(2, "71", expired));
    const cookie = await authorize();
    const response = await web.handle(request(targets, { headers: { Cookie: cookie } }));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ type: "role", items: [{ uid, region: "cn_gf01", regionName: "天空岛" }] });
    expect(paths).toEqual(["角色", "登录令牌", "会话凭据", "角色", "角色"]);
    expect((await profiles.accountContext("42", 2)).account.cookie).toBe(refreshed);
    const detail = await web.handle(request("api/goods/27", { headers: { Cookie: cookie } }));
    expect(detail?.status).toBe(200);
    expect(await detail?.json()).toMatchObject({ good: { id: "27" }, roles: [
      { uid, region: "cn_gf01", regionName: "天空岛" },
      { uid: "1000043", region: "cn_qd01", regionName: "世界树" },
    ] });
    expect(paths.slice(5)).toEqual(["商品", "角色"]);
    expect(await readFile(other, "utf8")).toBe(std);

    await writeFile(filename, profile(2, "71", expired));
    rebind = true;
    const before = paths.length;
    expect((await web.handle(request(targets, { headers: { Cookie: cookie } })))?.status).toBe(401);
    expect(paths.slice(before)).toEqual(["角色"]);
    expect((await profiles.accountContext("42", 2)).account.cookie).toBe("rebound");
    expect((await web.handle(request(targets, { headers: { Cookie: cookie } })))?.status).toBe(401);
    expect(paths.slice(before)).toEqual(["角色"]);
  } finally {
    web.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("商城匿名目录和缺省商品时间详情保留业务限频状态", async () => {
  for (const limitedRoute of ["list", "detail"]) {
    const reads: string[] = [];
    const catalog = createMiyousheShopCatalog({ async transport(source, init) {
      const url = new URL(String(source));
      const route = url.pathname.split("/").at(-1)!;
      reads.push(route);
      expect(new Headers(init?.headers).has("Cookie")).toBe(false);
      if (route === limitedRoute) return Response.json({ retcode: -331, message: "请求过快，请稍后再试" });
      return Response.json({ retcode: 0, data: {
        total: 1, list: [{ goods_id: 27, goods_name: "等待开放", price: 20, status: "not_in_sell", total: 0 }],
      } });
    } });
    await expect(catalog.list({ qq: "42", profileId: 1 }, new URLSearchParams())).rejects.toMatchObject({ status: 429 });
    expect(reads).toEqual(limitedRoute === "list" ? ["list"] : ["list", "detail"]);
  }
});

test("商城列表缺正式开放时间时使用详情补全，已有的下次时间可在失败时保留", async () => {
  const time = 1_792_000_000_000;
  for (const detailResponse of ["known", "no-time", "failed"]) {
    const reads: string[] = [];
    const same = { goods_id: 27, goods_name: "等待开放", price: 20, status: "not_in_sell", total: 0,
      game: "hk4e", next_time: (time + 90_000) / 1000 };
    const catalog = createMiyousheShopCatalog({ now: () => time, async transport(source) {
      const route = new URL(String(source)).pathname.split("/").at(-1)!;
      reads.push(route);
      if (route === "detail" && detailResponse === "failed") return new Response(null, { status: 503 });
      return Response.json({ retcode: 0, data: route === "list" ? { total: 1, list: [same] } :
        { ...same, game: "", next_time: undefined,
          ...(detailResponse === "known" && { sale_start_time: (time + 60_000) / 1000 }) } });
    } });
    const page = await catalog.list({ qq: "42", profileId: 1 }, new URLSearchParams());
    expect(reads).toEqual(["list", "detail"]);
    expect(page.goods[0]).toMatchObject({ game: "hk4e", status: "scheduled", opensAt: time + (detailResponse === "known" ? 60_000 : 90_000) });
  }
});

test("匿名商城仅在传输瞬断后重读，目录和详情仍按当前会话查询", async () => {
  const calls: string[] = [];
  const signal = new AbortController().signal;
  const time = 1_792_000_000_000;
  const catalog = createMiyousheShopCatalog({
    now: () => time,
    async transport(input, init) {
      const url = new URL(String(input));
      const route = url.pathname.split("/").at(-1)!;
      calls.push(route);
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
      expect(init?.signal?.aborted).toBe(false);
      expect(new Headers(init?.headers).has("Cookie")).toBe(false);
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      if (calls.filter(value => value === route).length <= 2) throw new TypeError("fixture connection closed");
      const row = { goods_id: 27, goods_name: "临时断线样本", price: 20, status: "not_in_sell", total: 0 };
      return Response.json({ retcode: 0, data: route === "list"
        ? { total: 1, list: [row] } : { ...row, sale_start_time: (time + 90_000) / 1000 } });
    },
  });
  const page = await catalog.list({ qq: "42", profileId: 1 }, new URLSearchParams(), signal);
  expect(page.goods[0]).toMatchObject({ id: "27", status: "scheduled", opensAt: time + 90_000 });
  expect(calls).toEqual(["list", "list", "list", "detail", "detail", "detail"]);
});

test("匿名商城读取消、已返回 HTTP 错误和耗尽重读分别结束", async () => {
  const target = { qq: "42", profileId: 1 };
  for (const status of [429, 503]) {
    let calls = 0;
    const catalog = createMiyousheShopCatalog({ async transport() {
      calls++;
      return new Response(null, { status });
    } });
    await expect(catalog.list(target, new URLSearchParams())).rejects.toMatchObject({ status: status === 429 ? 429 : 502 });
    expect(calls).toBe(1);
  }
  const controller = new AbortController();
  let calls = 0;
  const cancelled = createMiyousheShopCatalog({ async transport() {
    calls++;
    controller.abort();
    throw new TypeError("fixture connection cancelled");
  } });
  await expect(cancelled.list(target, new URLSearchParams(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  await expect(cancelled.list(target, new URLSearchParams(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(1);
  calls = 0;
  const offline = createMiyousheShopCatalog({ async transport() {
    calls++;
    throw new TypeError("fixture unreachable");
  } });
  await expect(offline.list(target, new URLSearchParams())).rejects.toMatchObject({ status: 502 });
  expect(calls).toBe(3);
});

test("退出米游社网页后，迟到的过期响应不换票或重读原档案", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-miyoushe-mission-logout-"));
  const profiles = createProfileStore(root);
  const filename = join(root, "42-2.yaml");
  const profile = Bun.YAML.stringify({
    user: { qq: "42" }, profile: { id: 2 },
    account: { cookie: "account_id=42;cookie_token=fixture-old;ltuid=42;ltoken=fixture", stuid: "42", ltuid: "42", stoken: "fixture-stoken" },
  });
  const start = Promise.withResolvers();
  const release = Promise.withResolvers();
  const reads: string[] = [];
  const overview = createMiyousheOverview({
    profileDirectory: root,
    async transport(url, options) {
      reads.push(url.origin + url.pathname);
      expect(options.method).toBe("GET");
      expect(url.hostname).toBe("bbs-api.miyoushe.com");
      start.resolve(undefined);
      await release.promise;
      return Response.json({ retcode: -100 });
    },
  });
  const web = createMiyousheWeb({
    publicBase: () => origin, databasePath: join(root, "auth.sqlite"), assetDirectory: "web/miyoushe",
    signal: session.signal, loginIdentity: profiles.loginIdentity, overview,
  });
  try {
    await writeFile(filename, profile, { mode: 0o600 });
    const reply = await web.commands.fallback!(command, message());
    const token = /#ticket=([\w-]{43})/u.exec(String(reply))?.[1];
    expect(token).toBeString();
    const authorization = await web.handle(claim(token!));
    const cookie = authorization!.headers.get("Set-Cookie")!.split(";", 1)[0]!;
    const pending = web.handle(read(cookie));
    await start.promise;
    try {
      const response = await web.handle(request("api/logout", { method: "POST", headers: { Origin: origin.origin, Cookie: cookie } }));
      expect(response?.status).toBe(204);
    } finally {
      release.resolve(undefined);
    }
    expect((await pending)?.status).toBe(401);
    expect(reads).toEqual(["https://bbs-api.miyoushe.com/apihub/wapi/getUserMissionsState"]);
    expect(await readFile(filename, "utf8")).toBe(profile);
  } finally {
    web.close();
    await rm(root, { recursive: true, force: true });
  }
});
