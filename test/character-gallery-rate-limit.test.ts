import { expect, test } from "bun:test";
import { createGallerySource } from "../lib/character-gallery-source.ts";

test("GitHub quota exhaustion reports its reset time without retrying or exposing the token", async () => {
  for (const status of [403, 429]) {
    let requests = 0;
    const source = createGallerySource({ signal: new AbortController().signal, githubToken: "private-fixture-token",
      fetch: async (url, init) => {
        requests++; expect(url.origin).toBe("https://api.github.com");
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer private-fixture-token");
        return new Response(null, { status, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1795748400" } });
      } });
    let error: unknown;
    try { await source.plan(); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("配额已耗尽");
    expect(String(error)).toContain("2026"); expect(String(error)).toContain("UTC+8");
    expect(String(error)).not.toContain("private-fixture-token");
    expect(requests).toBe(4);
  }
});

test("quota responses without a valid reset time retain a useful error", async () => {
  for (const reset of ["", "invalid"]) {
    const source = createGallerySource({ signal: new AbortController().signal,
      fetch: async () => new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } }) });
    await expect(source.plan()).rejects.toThrow("服务器未提供重置时间");
  }
  const denied = createGallerySource({ signal: new AbortController().signal,
    fetch: async () => new Response(null, { status: 403 }) });
  await expect(denied.plan()).rejects.toThrow("403");
});
