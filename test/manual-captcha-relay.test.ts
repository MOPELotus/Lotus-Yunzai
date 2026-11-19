import { expect, test } from "bun:test";
import { createManualCaptchaRelay, type ManualCaptchaRegistration, type ManualCaptchaTicket } from "../lib/captcha/manual-relay.ts";

const origin = "https://verify.example.invalid";
const prefix = "/captcha/manual";
const v3 = { captchaVersion: 3, gt: "fixture-gt", challenge: "registered-fixture", new_captcha: true } as const;
const v4 = { captchaVersion: 4, captchaId: "fixture-captcha-id", riskType: "slide", userInfo: "fixture-context" } as const;
const proof3 = { challenge: "completed-fixture", validate: "fixture-proof", seccode: "fixture-proof|jordan" };
const proof4 = { captchaVersion: 4, captchaId: v4.captchaId, lotNumber: "fixture-lot", captchaOutput: "fixture-output",
  passToken: "fixture-pass", genTime: "1730000000" } as const;
type Relay = ReturnType<typeof createManualCaptchaRelay>;

function path(reg: ManualCaptchaRegistration, action?: "register" | "validate" | "fail") {
  const link = new URL(reg.link);
  const id = link.pathname.split("/").at(-1)!;
  return action ? `${prefix}/GTest/${action}/${id}` : link.pathname;
}

function post(route: string, payload: unknown, init: RequestInit = {}) {
  return new Request(origin + route, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(payload), ...init });
}

async function required<T>(value: Promise<T | undefined>): Promise<T> {
  const result = await value;
  if (result === undefined) throw new Error("fixture did not receive a relay response");
  return result;
}

function get(relay: Relay, route: string, init?: RequestInit) {
  return required(relay.handlePublic(new Request(origin + route, init)));
}

test("同端口在固定前缀复用原页面和素材，公网无法注册或领取终态", async () => {
  const relay = createManualCaptchaRelay({ publicUrl: origin });
  try {
    expect(await relay.handlePublic(new Request(`${origin}/status`))).toBeUndefined();
    expect(await relay.handlePublic(new Request(`${origin}${prefix}-other/verify.js`))).toBeUndefined();
    const reg = await required(relay.register(v3));
    expect(reg.link).toMatch(/^https:\/\/verify\.example\.invalid\/captcha\/manual\/GTest\/[A-Za-z0-9_-]{32}$/u);
    expect(Object.keys(reg).sort()).toEqual(["expiresAt", "link", "ticket"]);
    const page = await get(relay, path(reg));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("人工验证");
    expect(html).toContain('src="/captcha/manual/verify.js"');
    expect(html).toContain('href="/captcha/manual/verify.css"');
    expect(html).not.toContain(v3.challenge);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(page.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(page.headers.get("X-Content-Type-Options")).toBe("nosniff");
    for (const [file, type] of [["verify.js", "text/javascript"], ["verify.css", "text/css"]]) {
      const asset = await get(relay, `${prefix}/${file}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("Content-Type")).toContain(type!);
      expect(await asset.text()).toBe(await Bun.file(new URL(`../vendor/gt-manual/public/${file}`, import.meta.url)).text());
    }
    for (const route of [`${prefix}/healthz`, `${prefix}/verify.js?v=1`, `${prefix}/GTest/register`,
      path(reg, "validate"), path(reg, "fail"), path(reg).replace("/GTest/", "/%47Test/")]) {
      expect((await get(relay, route)).status).toBe(404);
    }
    expect((await required(relay.handlePublic(post(`${prefix}/GTest/register`, v3)))).status).toBe(404);
    expect((await get(relay, path(reg), { method: "HEAD" })).status).toBe(404);
    const claim = await get(relay, path(reg, "register"));
    expect(claim.status).toBe(200);
    expect(await claim.json()).toEqual(v3);
    expect((await get(relay, path(reg, "register"))).status).toBe(409);
    expect(await relay.readResult(reg.ticket)).toEqual({ status: "pending" });
    const submitted = await required(relay.handlePublic(post(path(reg, "validate"), proof3)));
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toEqual({ status: 0, message: "OK", data: {} });
    expect((await get(relay, path(reg, "validate"))).status).toBe(404);
    expect(await relay.readResult(reg.ticket)).toEqual({ status: "complete", result: proof3 });
    expect(await relay.readResult(reg.ticket)).toEqual({ status: "unavailable" });
  } finally {
    relay.close();
  }
});

test("真实 HTTP 同一监听器保留预配置域，凭证票据只属于创建它的实例", async () => {
  const relay = createManualCaptchaRelay({ publicUrl: origin });
  const foreign = createManualCaptchaRelay({ publicUrl: origin });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    return await relay.handlePublic(request) ?? Response.json({ sameListener: true });
  } });
  try {
    const reg = await required(relay.register(v4));
    expect(await foreign.readResult(reg.ticket)).toEqual({ status: "unavailable" });
    expect(await relay.readResult({} as ManualCaptchaTicket)).toEqual({ status: "unavailable" });
    const headers = { Host: new URL(origin).host };
    const request = (route: string, init: RequestInit = {}) => fetch(new URL(route, server.url), { ...init,
      headers: { ...headers, ...init.headers } });
    expect(await (await request("/status")).json()).toEqual({ sameListener: true });
    expect((await request(path(reg))).status).toBe(200);
    const claim = await request(path(reg, "register"));
    expect(claim.status).toBe(200);
    expect(await claim.json()).toEqual(v4);
    expect((await request(path(reg, "validate"), { method: "POST", body: JSON.stringify(proof4), headers: {
      Origin: origin, "Content-Type": "application/json",
    } })).status).toBe(200);
    const results = await Promise.all([relay.readResult(reg.ticket), relay.readResult(reg.ticket)]);
    expect(results.filter((result) => result.status === "complete")).toEqual([{ status: "complete", result: proof4 }]);
    expect(results.filter((result) => result.status === "unavailable")).toHaveLength(1);
  } finally {
    relay.close();
    foreign.close();
    server.stop(true);
  }
});

test("提交只接受固定 HTTPS Origin 和 Host，拒绝非法媒体、超限流和已断开请求", async () => {
  const relay = createManualCaptchaRelay({ publicUrl: origin });
  try {
    const reg = await required(relay.register(v3));
    const claim = path(reg, "register");
    const submit = path(reg, "validate");
    expect((await get(relay, claim, { headers: { Host: "elsewhere.invalid", Origin: origin } })).status).toBe(404);
    expect((await required(relay.handlePublic(new Request("https://elsewhere.invalid" + claim,
      { headers: { Host: new URL(origin).host, Origin: origin } })))).status).toBe(404);
    expect((await get(relay, claim, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await get(relay, claim)).status).toBe(200);
    for (const badOrigin of [undefined, "null", "https://elsewhere.invalid", "http://verify.example.invalid", origin + "/"]) {
      const headers = new Headers({ "Content-Type": "application/json", "X-Forwarded-Host": new URL(origin).host,
        "X-Forwarded-Proto": "https" });
      if (badOrigin !== undefined) headers.set("Origin", badOrigin);
      expect((await required(relay.handlePublic(post(submit, proof3, { headers })))).status).toBe(403);
    }
    expect((await required(relay.handlePublic(post(submit, proof3, {
      headers: { Origin: origin, "Content-Type": "application/jsonx" },
    })))).status).toBe(415);
    expect((await required(relay.handlePublic(post(submit, proof3, {
      headers: { Origin: origin, "Content-Type": "application/json", "Content-Length": "16385" },
    })))).status).toBe(413);
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(9000));
        controller.enqueue(new Uint8Array(9000));
      },
      cancel() { cancelled = true; },
    });
    expect((await required(relay.handlePublic(post(submit, proof3, { body: stream })))).status).toBe(413);
    expect(cancelled).toBe(true);
    const controller = new AbortController();
    const read = Promise.withResolvers<void>();
    const interrupted = relay.handlePublic(post(submit, proof3, {
      signal: controller.signal,
      body: new ReadableStream<Uint8Array>({ pull() { read.resolve(); } }, { highWaterMark: 0 }),
    }));
    await read.promise;
    controller.abort();
    expect((await required(interrupted)).status).toBe(400);
    expect(await relay.readResult(reg.ticket)).toEqual({ status: "pending" });
    expect((await required(relay.handlePublic(post(submit, proof3)))).status).toBe(200);
  } finally {
    relay.close();
  }
});

test("释放过期/失败票据、关闭期间中止读取并禁止旧实例复用", async () => {
  let now = 120_000;
  const relay = createManualCaptchaRelay({ publicUrl: origin, ttlMs: 200, resultTtlMs: 100, maxTasks: 1, now: () => now });
  try {
    const expires = await required(relay.register(v4));
    expect(expires.expiresAt).toBe(120_200);
    expect(await relay.register(v4)).toBeUndefined();
    now += 201;
    expect((await get(relay, path(expires))).status).toBe(410);
    expect(await relay.readResult(expires.ticket)).toEqual({ status: "complete",
      result: { ok: false, reason: "manual_expired", captchaVersion: 4 } });
    const failed = await required(relay.register(v3));
    expect((await get(relay, path(failed, "register"))).status).toBe(200);
    expect((await required(relay.handlePublic(post(path(failed, "fail"), { reason: "manual_closed" })))).status).toBe(200);
    expect(await relay.readResult(failed.ticket)).toEqual({ status: "complete",
      result: { ok: false, reason: "manual_closed", captchaVersion: 3 } });
    const pending = await required(relay.register(v4));
    expect((await get(relay, path(pending, "register"))).status).toBe(200);
    const read = Promise.withResolvers<void>();
    let cancelled = false;
    const blocked = relay.handlePublic(post(path(pending, "validate"), proof4, {
      body: new ReadableStream<Uint8Array>({
        pull() { read.resolve(); },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 }),
    }));
    await read.promise;
    relay.close();
    expect((await required(blocked)).status).toBe(503);
    expect(cancelled).toBe(true);
    expect(await relay.readResult(pending.ticket)).toEqual({ status: "unavailable" });
    expect(await relay.register(v3)).toBeUndefined();
    expect((await get(relay, path(pending))).status).toBe(503);
  } finally {
    relay.close();
  }
});

test("公开地址与前缀在启动时固定校验", async () => {
  for (const publicUrl of ["http://public.example.invalid", "https://user@host.invalid", "https://a.invalid/a/..",
    "https://a.invalid?x=1", "https://a.invalid#f", " https://a.invalid", "https://a.invalid:0", "ftp://a.invalid"]) {
    expect(() => createManualCaptchaRelay({ publicUrl })).toThrow();
  }
  for (const basePath of ["/", "/captcha/../relay", "/captcha//relay", "captcha/manual", "/captcha/manual/"]) {
    expect(() => createManualCaptchaRelay({ publicUrl: origin, basePath })).toThrow();
  }
  const relay = createManualCaptchaRelay({ publicUrl: "http://127.0.0.1:12451/", basePath: "/manual-test" });
  try {
    const reg = await required(relay.register(v4));
    expect(reg.link.startsWith("http://127.0.0.1:12451/manual-test/GTest/")).toBe(true);
  } finally {
    relay.close();
  }
});
