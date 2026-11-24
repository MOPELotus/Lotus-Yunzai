import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readServerSettings } from "../lib/server.ts";

async function fixture(run: (root: URL, configure: (config: object, legacy?: boolean) => Promise<void>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-https-settings-"));
  try {
    await run(pathToFileURL(directory + "/"), async (config, legacy = false) => {
      const location = join(directory, legacy ? "config/config" : "config");
      await mkdir(location, { recursive: true });
      await writeFile(join(location, "server.yaml"), JSON.stringify(config));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const pair = { key: " config/server:key.pem ", cert: "/fixture/nonexistent-cert.pem" };

test("旧 HTTPS 配置只解析文件路径，省略端口使用随机端口，公开地址与 HTTP 独立", () => fixture(async (root, configure) => {
  await configure({
    port: 2536, url: "http://localhost:2536/bot/", auth: { "X-Lotus-Key": "test" },
    https: { ...pair, url: "https://Public.example:8443/proxy///" },
  }, true);
  const settings = await readServerSettings(root, {
    LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "25360", LOTUS_HTTP_TOKEN: "http-fixture", LOTUS_ONEBOT_TOKEN: "onebot-fixture",
  });
  expect(settings.https).toMatchObject({ ...pair, port: 0 });
  expect(settings.httpsError).toBeUndefined();
  expect(settings.publicUrl?.href).toBe("http://localhost:2536/bot/");
  expect(settings.https?.publicUrl?.href).toBe("https://public.example:8443/proxy/");
  expect(settings.http?.port).toBe(0);
  expect(settings.oneBot?.port).toBe(25360);

  const secure = settings.https!;
  expect(secure.auth.get("Authorization")).toBe("Bearer http-fixture");
  expect(secure.oneBotAuth?.get("Authorization")).toBe("Bearer onebot-fixture");
  expect(secure.auth.get("X-Lotus-Key")).toBe("test");
  expect(secure.oneBotAuth?.get("X-Lotus-Key")).toBe("test");
  expect(secure.auth).not.toBe(settings.http?.auth);
  expect(secure.oneBotAuth).not.toBe(settings.oneBot?.auth);
}));

test("有效 TLS 可选启用，默认保留内网 HTTP 与 OneBot", () => fixture(async (root, configure) => {
  await configure({ https: { ...pair, port: "8443", url: "http://proxy.example/lotus" } });
  const settings = await readServerSettings(root, {});
  expect(settings.https?.port).toBe(8443);
  expect(settings.https?.publicUrl?.href).toBe("http://proxy.example/lotus/");
  expect([...settings.https!.oneBotAuth!]).toEqual([]);
  expect(settings.https?.auth.get("Authorization")).toBeNull();
  expect(settings.http?.port).toBe(2536);
  expect(settings.oneBot?.port).toBe(2536);
  expect(settings.publicUrl).toBeUndefined();
}));

test("未配置 TLS 时安静禁用，错误的可选 TLS 不影响 HTTP 和 WS 配置", () => fixture(async (root, configure) => {
  for (const https of [undefined, null, false, {}, { key: "", cert: null }]) {
    await configure({ port: 0, https });
    const settings = await readServerSettings(root, {});
    expect(settings.https).toBeUndefined();
    expect(settings.httpsError).toBeUndefined();
  }

  for (const https of [
    true, [], "https://fixture.invalid/", { key: pair.key }, { port: 8443 }, { ...pair, cert: 42 },
    { ...pair, cert: "config/cert.pem\0" },
    { ...pair, port: 65_536 }, { ...pair, port: "not-a-port" }, { ...pair, url: "/relative" },
    { ...pair, url: "https://user:fixture@example.invalid/" },
  ]) {
    await configure({ url: "http://localhost:2536", port: 2536, https });
    const settings = await readServerSettings(root, { LOTUS_ONEBOT_TOKEN: "fixture" });
    expect(settings.https).toBeUndefined();
    expect(settings.httpsError).toBe(true);
    expect(settings.http?.port).toBe(2536);
    expect(settings.oneBot?.auth.get("Authorization")).toBe("Bearer fixture");
    expect(settings.publicUrl?.href).toBe("http://localhost:2536/");
  }
}));
