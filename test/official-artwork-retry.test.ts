import { expect, test } from "bun:test";
import { loadOfficialArtwork, loadPublicQqAvatar } from "../packages/account/official-artwork.ts";
import { withReadRetries } from "../packages/http/index.ts";
const url = "https://upload-bbs.mihoyo.com/roles/fixture-retry.png";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR42mMU1TBjYGBgYmBgQFAACLwAebTfQhYAAAAASUVORK5CYII=", "base64");
const picture = () => new Response(png, { headers: { "Content-Type": "image/png" } });

test("公开原图连接及二进制读流共用三次预算，不与已包装传输叠乘", async () => {
  let calls = 0;
  const transport = withReadRetries(async (_url, init) => {
    calls++;
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
    expect(new Headers(init.headers).has("Cookie")).toBe(false);
    if (calls === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    if (calls === 2) return new Response(new ReadableStream({ start(controller) {
      controller.error(Object.assign(new Error("body reset"), { code: "ECONNRESET" }));
    } }), { headers: { "Content-Type": "image/png" } });
    return picture();
  });
  expect((await loadOfficialArtwork([url], { transport })).get(url)).toEqual(png);
  expect(calls).toBe(3);
});

test("公开头像使用同一预算，图片验证错误和明确冷却不会重试", async () => {
  let calls = 0;
  expect(await loadPublicQqAvatar("42", { transport: async target => {
    calls++;
    expect(target.href).toBe("https://q.qlogo.cn/g?b=qq&s=0&nk=42");
    if (calls < 3) return new Response(null, { status: 502 });
    return picture();
  } })).toEqual(png);
  expect(calls).toBe(3);
  for (const invalid of [() => new Response("html", { headers: { "Content-Type": "text/html" } }),
    () => new Response(png, { headers: { "Content-Type": "image/png", "Content-Length": "2000000" } }),
    () => new Response(null, { status: 429 }),
    () => new Response(null, { status: 503, headers: { "Retry-After": "60" } })]) {
    calls = 0;
    expect((await loadOfficialArtwork([url], { transport: async () => { calls++; return invalid(); } })).size).toBe(0);
    expect(calls).toBe(1);
  }
});

test("取消公开原图读取不重发", async () => {
  const controller = new AbortController(); let calls = 0;
  expect((await loadOfficialArtwork([url], { signal: controller.signal, transport: async () => {
    calls++; controller.abort(); throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
  } })).size).toBe(0);
  expect(calls).toBe(1);
});
