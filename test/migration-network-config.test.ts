import { expect, test } from "bun:test";
import { parseMilkySettings } from "../lib/adapters/milky-config.ts";
import { projectLegacyNetworkConfig } from "../lib/migration-network-config.ts";
import { authorized, parseServerSettings } from "../lib/server.ts";
import { parseStorageSettings } from "../lib/valkey-config.ts";

test("retains old server routing and header auth, with explicit split ingress overrides", () => {
  const server = {
    url: "https://bot.example.invalid/relay", port: 42126, auth: { Authorization: "Bearer sample-token" },
    redirect: "https://docs.example.invalid/", https: null, unsupported: "omitted",
  };
  const { config, notes, deferred } = projectLegacyNetworkConfig({ server });
  expect(config.server).toEqual({ url: server.url, port: server.port, auth: server.auth, redirect: server.redirect, https: null });
  expect(notes).toEqual(["server.listeners.shared", "server.listeners.all-interfaces-default", "server.authorization.headers-only"]);
  expect(deferred).toEqual([]);
  const defaults = parseServerSettings(config.server!, {});
  expect(defaults.hostname).toBe("0.0.0.0");
  expect(defaults.http?.port).toBe(defaults.oneBot?.port);
  expect(defaults.publicUrl?.pathname).toBe("/relay/");
  expect(authorized(new Request("http://127.0.0.1/status?Authorization=Bearer%20sample-token"), defaults.http!.auth)).toBe(false);
  expect(authorized(new Request("http://127.0.0.1/status", { headers: server.auth }), defaults.http!.auth)).toBe(true);
  const env = { LOTUS_HTTP_PORT: "42127", LOTUS_ONEBOT_PORT: "42128", LOTUS_HTTP_TOKEN: "http-fixture", LOTUS_ONEBOT_TOKEN: "ws-fixture" };
  const split = projectLegacyNetworkConfig({ server }, { serverEnvironment: env });
  expect(split.notes).toContain("server.listeners.separate");
  const settings = parseServerSettings(split.config.server!, env);
  expect(settings.http?.port).toBe(42127);
  expect(settings.oneBot?.port).toBe(42128);
  expect(settings.http?.auth.get("Authorization")).toBe("Bearer http-fixture");
  expect(settings.oneBot?.auth.get("Authorization")).toBe("Bearer ws-fixture");
  expect(split.config.server).toEqual(config.server);
});

test("holds TLS file material and flags only nonzero collisions", () => {
  const server = {
    port: 42126, auth: {}, https: { key: "/synthetic/private.pem", cert: "assets/local.pem", port: 42126 },
  };
  const result = projectLegacyNetworkConfig({ server });
  expect(result.config.server?.https).toBeUndefined();
  expect(result.deferred).toEqual(["server.https.port-collision", "server.https.files"]);
  expect(JSON.stringify(result.deferred)).not.toContain("synthetic");
  const dynamic = projectLegacyNetworkConfig({ server: { ...server, port: 0, https: { ...server.https, port: 0 } } });
  expect(dynamic.deferred).not.toContain("server.https.port-collision");
  expect(projectLegacyNetworkConfig({ server: { https: { key: server.https.key } } }).deferred).toContain("server.https.invalid");
  expect(projectLegacyNetworkConfig({ server: { https: false } }).config.server).toEqual({ https: false });
});

test("retains disabled Milky and requires explicit policy for remote enabled routes", () => {
  const milky = { enable: true, host: "https://milky.example.invalid", port: 42113, prefix: "/fixture/",
    access_token: "sample-milky-token", connection: "ws", http_timeout: 2.5,
    ws: { heartbeat: 7, reconnect_interval: 4, obsolete: "ignored" } };
  const held = projectLegacyNetworkConfig({ milky });
  expect(held).toEqual({ config: {}, deferred: ["milky.remote"], notes: [] });
  const disabled = projectLegacyNetworkConfig({ milky: { ...milky, enable: false } });
  expect(disabled.config.milky?.enable).toBe(false);
  expect(parseMilkySettings(disabled.config.milky!)).toBeUndefined();
  const allowed = projectLegacyNetworkConfig({ milky }, { remoteMilky: true });
  const settings = parseMilkySettings(allowed.config.milky!)!;
  expect(settings.apiBase.pathname).toBe("/fixture/api/");
  expect(settings.eventUrl.pathname).toBe("/fixture/event");
  expect(settings.eventUrl.protocol).toBe("wss:");
  expect(settings.eventUrl.search).toBe("");
  expect(settings.accessToken).toBe("sample-milky-token");
  expect([settings.timeoutMs, settings.heartbeatMs, settings.reconnectMs]).toEqual([2500, 7000, 4000]);
  expect(allowed.config.milky?.ws).toEqual({ heartbeat: 7, reconnect_interval: 4 });
  expect(allowed.notes).toEqual(["milky.ws.authorization-header"]);
});

test("preserves old Milky TLS selection and keeps webhook authorization explicit", () => {
  const milky = { enable: true, host: "127.0.0.1", port: 443, connection: "webhook", webhook: { path: "/legacy-milky" } };
  const held = projectLegacyNetworkConfig({ milky });
  expect(held.config.milky).toBeUndefined();
  expect(held.deferred).toEqual(["milky.webhook.authorization"]);
  const allowed = projectLegacyNetworkConfig({ milky }, { serverEnvironment: { LOTUS_HTTP_TOKEN: "fixture-http-token" } });
  expect(parseMilkySettings(allowed.config.milky!)).toMatchObject({ connection: "webhook", webhookPath: "/legacy-milky" });
  expect(parseMilkySettings(allowed.config.milky!)?.apiBase.protocol).toBe("https:");
  const explicitOldPort = projectLegacyNetworkConfig({ milky: { ...milky, connection: "ws", port: "443" } });
  expect(parseMilkySettings(explicitOldPort.config.milky!)?.apiBase.protocol).toBe("http:");
  const explicitSsl = projectLegacyNetworkConfig({ milky: { ...milky, connection: "ws", port: "443", ssl: 1 } });
  expect(parseMilkySettings(explicitSsl.config.milky!)?.apiBase.protocol).toBe("https:");
  const embeddedPort = projectLegacyNetworkConfig({ milky: { ...milky, connection: "ws", host: "127.0.0.1:443", port: 3000 } });
  expect(parseMilkySettings(embeddedPort.config.milky!)?.apiBase.protocol).toBe("http:");
  const embeddedTls = projectLegacyNetworkConfig({ milky: { ...milky, connection: "ws", host: "127.0.0.1:42127" } });
  expect(parseMilkySettings(embeddedTls.config.milky!)?.apiBase.protocol).toBe("https:");
  expect(() => projectLegacyNetworkConfig({ milky: { ...milky, webhook: { path: "/status" } } })).toThrow("webhook.path");
});

test("retains Redis endpoint, ACL and database selection while omitting the old executable", () => {
  const redis = { host: "redis.example.invalid", port: "42502", username: "fixture-app", password: "test : @#", db: "11",
    path: "/old/path/redis-server", unsupported: "omit" };
  const held = projectLegacyNetworkConfig({ redis });
  expect(held).toEqual({ config: {}, deferred: ["redis.remote"], notes: ["redis.existing-service"] });
  const enabled = projectLegacyNetworkConfig({ redis }, { remoteRedis: true });
  expect(enabled.config.redis?.path).toBeUndefined();
  expect(enabled.config.redis?.unsupported).toBeUndefined();
  expect(parseStorageSettings(enabled.config.redis!)).toEqual({
    host: redis.host, port: 42502, username: redis.username, password: redis.password, database: 11,
  });
  expect(projectLegacyNetworkConfig({ redis: { ...redis, host: "[::1]" } }).config.redis).toBeDefined();
  expect(projectLegacyNetworkConfig({}).config).toEqual({});
});
