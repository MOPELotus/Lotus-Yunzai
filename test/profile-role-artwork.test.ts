import { expect, test } from "bun:test";
import { loadProfileRoleArtwork } from "../lib/profile-role-artwork.ts";
import { normalizeProfileRoleArtworkUrl } from "../packages/account/role-artwork-url.ts";

const cdn = "https://upload-bbs.mihoyo.com";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR42mMU1TBjYGBgYmBgQFAACLwAebTfQhYAAAAASUVORK5CYII=", "base64");
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJGASK//2Q==", "base64");
const webp = Buffer.from("UklGRjAAAABXRUJQVlA4ICQAAABwAQCdASoCAAMAAUAmJYwCdAFAAAD++onfAkrVhe4NkimuwAA=", "base64");

test("角色原图只规范化精确官方 HTTPS 图片地址并移除查询与片段", () => {
  expect(normalizeProfileRoleArtworkUrl(" https://UPLOAD-BBS.MIHOYO.COM:443/roles/a.PNG?authkey=fixture#x ")).toBe(
    `${cdn}/roles/a.PNG`,
  );
  expect(normalizeProfileRoleArtworkUrl("https://upload-bbs.miyoushe.com/roles/a.webp")).toBe(
    "https://upload-bbs.miyoushe.com/roles/a.webp",
  );
  expect(normalizeProfileRoleArtworkUrl("https://upload-os-bbs.hoyolab.com/roles/a.jpg")).toBe(
    "https://upload-os-bbs.hoyolab.com/roles/a.jpg",
  );
  for (const source of [
    undefined, null, 123, "not-an-image", "file:///tmp/a.png", "//upload-bbs.mihoyo.com/roles/a.png",
    "http://upload-bbs.mihoyo.com/roles/a.png", "https://upload-bbs.mihoyo.com:8443/roles/a.png",
    "https://user:secret@upload-bbs.mihoyo.com/roles/a.png", "https://upload-bbs.mihoyo.com@example.invalid/roles/a.png",
    "https://upload-bbs.mihoyo.com.example.invalid/roles/a.png", "https://images.mihoyo.com/roles/a.png",
    "https://127.0.0.1/roles/a.png", "https://[::1]/roles/a.png",
    "https://upload-bbs.mihoyo.com/roles/a.svg", "https://upload-bbs.mihoyo.com/image?name=a.png",
  ]) expect(normalizeProfileRoleArtworkUrl(source)).toBeUndefined();
});

test("角色原图接受三种栅格格式，拒绝跳转、非图片、伪内容与超限图", async () => {
  const wide = Buffer.from(png);
  wide.writeUInt32BE(5000, 16);
  let oversizedCancelled = false;
  const responses = new Map<string, () => Response>([
    ["/test.png", () => new Response(png, { headers: { "content-type": "image/png; x-proxy=fixture" } })],
    ["/test.jpg", () => new Response(jpeg, { headers: { "content-type": "image/jpeg" } })],
    ["/test.webp", () => new Response(webp, { headers: { "content-type": "image/webp" } })],
    ["/redirect.png", () => Response.redirect("https://example.invalid/redirect.png")],
    ["/wrong.png", () => new Response("<html>fixture</html>", { headers: { "content-type": "text/html" } })],
    ["/wrong.webp", () => new Response(png, { headers: { "content-type": "image/webp" } })],
    ["/oversized.png", () => new Response(png, { headers: { "content-type": "image/png", "content-length": "1048577" } })],
    ["/wide.png", () => new Response(wide, { headers: { "content-type": "image/png" } })],
    ["/stream.png", () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
      cancel() { oversizedCancelled = true; },
    }), { headers: { "content-type": "image/png" } })],
  ]);
  const called = new Set<string>();
  const results = await loadProfileRoleArtwork([
    "https://example.invalid/offsite.png", ...[...responses.keys()].map((path) => cdn + path),
    `${cdn}/test.png?token=fixture`,
  ], { async transport(url, init) {
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    const headers = new Headers(init.headers);
    expect(headers.get("Cookie")).toBeNull();
    expect(headers.get("Authorization")).toBeNull();
    expect(url.origin).toBe(cdn);
    expect(url.search).toBe("");
    expect(called.has(url.href)).toBe(false);
    called.add(url.href);
    return responses.get(url.pathname)?.() ?? new Response(null, { status: 404 });
  } });
  expect(called.size).toBe(responses.size);
  expect(results.size).toBe(3);
  expect(results.get(`${cdn}/test.png`)).toEqual(png);
  expect(results.get(`${cdn}/test.jpg`)).toEqual(jpeg);
  expect(results.get(`${cdn}/test.webp`)).toEqual(webp);
  expect(oversizedCancelled).toBe(true);
});

test("角色原图限制总数量与并行数，取消可停止正在读取的响应", async () => {
  const blockedAtFour = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let count = 0;
  let peak = 0;
  let active = 0;
  const loading = loadProfileRoleArtwork(Array.from({ length: 32 }, (_, id) => `${cdn}/avatars/${id}.png`), {
    async transport() {
      count++;
      active++;
      peak = Math.max(peak, active);
      if (active === 4) blockedAtFour.resolve();
      await release.promise;
      active--;
      return new Response(png, { headers: { "content-type": "image/png" } });
    },
  });
  await blockedAtFour.promise;
  expect(count).toBe(4);
  release.resolve();
  expect((await loading).size).toBe(24);
  expect(count).toBe(24);
  expect(peak).toBe(4);

  const abort = new AbortController();
  const reading = Promise.withResolvers<void>();
  let cancelled = false;
  const interrupted = loadProfileRoleArtwork([`${cdn}/slow.png`], {
    signal: abort.signal,
    async transport() {
      return new Response(new ReadableStream({
        pull() { reading.resolve(); },
        cancel() { cancelled = true; },
      }), { headers: { "content-type": "image/png" } });
    },
  });
  await reading.promise;
  abort.abort();
  expect((await interrupted).size).toBe(0);
  expect(cancelled).toBe(true);
});
