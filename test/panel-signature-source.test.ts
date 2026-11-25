import { expect, test } from "bun:test";
import { readPublicGameSignature } from "../lib/panel-signature-source.ts";

const gs = "123450001", sr = "123450002";
const signature = " 示例短码 ";
const active = () => new AbortController().signal;
const genshin = (overrides = {}) => Response.json({ uid: gs, ttl: 87, playerInfo: { signature }, ...overrides });
const starRail = (overrides = {}) => Response.json({ detailInfo: { uid: Number(sr), signature }, ...overrides });

test("签名只向两个固定的匿名公开地址读取，按游戏返回原字段与缓存提示", async () => {
  const sent: string[] = [];
  const signal = active();
  const read: NonNullable<Parameters<typeof readPublicGameSignature>[3]> = async (url, init) => {
    sent.push(url.href);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(init.body).toBeUndefined();
    expect([...new Headers(init.headers).keys()]).toEqual(["accept", "user-agent"]);
    expect(init.signal?.aborted).toBe(false);
    return url.hostname === "enka.network" ? genshin() : starRail();
  };
  expect(await readPublicGameSignature("gs", gs, signal, read)).toEqual({ state: "ready", signature, ttlSeconds: 87 });
  expect(await readPublicGameSignature("sr", sr, signal, read)).toEqual({ state: "ready", signature, ttlSeconds: 120 });
  expect(sent).toEqual([`https://enka.network/api/uid/${gs}/?info`, `https://api.mihomo.me/sr_info/${sr}`]);
  expect(await readPublicGameSignature("gs", gs, signal, async () => genshin({ uid: Number(gs), ttl: 0 })))
    .toEqual({ state: "ready", signature, ttlSeconds: 0 });
  expect(await readPublicGameSignature("sr", sr, signal, async () => starRail({ uid: sr, ttl: "23" })))
    .toEqual({ state: "ready", signature, ttlSeconds: 23 });
});

test("拒绝伪造请求路径、不同 UID、占位资料和异常字段", async () => {
  let calls = 0;
  for (const uid of ["10000001", "0", "+123450001", "123450001/../../", "123450001?qq=42", "123450001 "]) {
    const result = await readPublicGameSignature("gs", uid, active(), async () => { calls++; return genshin(); });
    expect(result.state).toBe("unavailable");
  }
  expect(calls).toBe(0);
  for (const payload of [
    { uid: sr, playerInfo: { signature } }, { uid: undefined, playerInfo: { signature } },
    { uid: gs, playerInfo: { uid: sr, signature } }, { playerInfo: { signature: ["fake"] } },
    { playerInfo: { signature: "a".repeat(257) } }, { playerInfo: { signature: "a\u0000b" } },
  ]) {
    expect((await readPublicGameSignature("gs", gs, active(), async () => genshin(payload))).state).toBe("unavailable");
  }
  for (const payload of [
    { detailInfo: { uid: gs, signature } }, { detailInfo: { signature } },
    { uid: gs, detailInfo: { uid: sr, signature } }, { detailInfo: null },
  ]) {
    expect((await readPublicGameSignature("sr", sr, active(), async () => starRail(payload))).state).toBe("unavailable");
  }
  expect(await readPublicGameSignature("gs", gs, active(), async () => genshin({ profileUnavailable: true })))
    .toEqual({ state: "no-signature", ttlSeconds: 87 });
  expect(await readPublicGameSignature("sr", sr, active(), async () => starRail({ detailInfo: { uid: sr } })))
    .toEqual({ state: "no-signature", ttlSeconds: 120 });
});

test("允许明确的缺签名，拒绝重定向、坏编码、大回包及连接中断", async () => {
  expect(await readPublicGameSignature("gs", gs, active(), async () => new Response(null, { status: 404 })))
    .toEqual({ state: "no-signature", ttlSeconds: 60 });
  expect(await readPublicGameSignature("sr", sr, active(), async () => new Response(null, { status: 429, headers: { "Retry-After": "231" } })))
    .toEqual({ state: "unavailable", ttlSeconds: 231 });
  const redirect = Response.redirect("https://untrusted.example.invalid/profile");
  const wrongLocation = genshin();
  Object.defineProperty(wrongLocation, "url", { value: "https://untrusted.example.invalid/profile" });
  const declaredTooLarge = Response.json({}, { headers: { "Content-Length": "1048576" } });
  const tooLarge = Response.json({ uid: gs, playerInfo: { signature }, filler: "x".repeat(66 * 1024) });
  const invalidUtf8 = new Response(Uint8Array.of(0xc0, 0xaf), { headers: { "Content-Type": "application/json" } });
  for (const response of [redirect, wrongLocation, declaredTooLarge, tooLarge, invalidUtf8, new Response("HTML", { status: 200 })]) {
    expect((await readPublicGameSignature("gs", gs, active(), async () => response)).state).toBe("unavailable");
  }
  const stop = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = readPublicGameSignature("sr", sr, stop.signal, async () =>
    new Response(stream, { headers: { "Content-Type": "application/json" } }));
  await Bun.sleep(0);
  stop.abort();
  expect((await pending).state).toBe("unavailable");
  expect(cancelled).toBe(true);
});

test("公开签名临时连接错误有限重试，取消及限流保持停止", async () => {
  let calls = 0;
  const result = await readPublicGameSignature("gs", gs, active(), async () => {
    if (++calls < 3) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    return genshin();
  });
  expect(calls).toBe(3); expect(result.state).toBe("ready");
  calls = 0;
  await readPublicGameSignature("gs", gs, active(), async () => { calls++; return new Response("", { status: 503 }); });
  expect(calls).toBe(3);
  calls = 0;
  await readPublicGameSignature("gs", gs, active(), async () => { calls++; return new Response("", { status: 503, headers: { "Retry-After": "10" } }); });
  expect(calls).toBe(1);
  const stop = new AbortController(); calls = 0;
  await readPublicGameSignature("gs", gs, stop.signal, async () => { calls++; stop.abort(); throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); });
  expect(calls).toBe(1);
});

test("签名重试重新检查读守卫，过期会话不再发送请求", async () => {
  let calls = 0, guards = 0;
  const result = await readPublicGameSignature("gs", gs, active(), async () => {
    calls++; throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
  }, async () => { if (++guards > 1) throw new Error("session expired"); });
  expect(result.state).toBe("unavailable"); expect(calls).toBe(1); expect(guards).toBe(2);
});
