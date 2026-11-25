import { afterEach, expect, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readMilkySettings } from "../lib/adapters/milky-config.ts";
import { stageLegacyNetworkConfig } from "../lib/migration-network-config.ts";
import { httpStatus, readServerSettings } from "../lib/server.ts";
import { readStorageConnection } from "../lib/valkey-config.ts";

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
  fixture = undefined;
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "lotus-migrate-network-stage-"));
  fixture = directory;
  const source = join(directory, "legacy");
  const stage = join(directory, "stage");
  await mkdir(source);
  await mkdir(stage);
  return { directory, source, stage };
}

async function put(root: string, path: string, data: string | Record<string, unknown>) {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, typeof data === "string" ? data : Bun.YAML.stringify(data), { mode: 0o600 });
}

function certificate(root: string, label: string) {
  const key = join(root, label + "-key.pem");
  const cert = join(root, label + "-cert.pem");
  const child = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert],
  { stdout: "ignore", stderr: "ignore" });
  expect(child.exitCode).toBe(0);
  return { key, cert };
}

test("stages only named YAML and keeps the primary schema, explicitly configured remote endpoints and private modes", async () => {
  const { source, stage } = await setup();
  await put(source, ".env", "LOTUS_VALKEY_URL=must-not-copy");
  await put(source, "config/default_config/server.yaml", "[invalid old value ignored by active configuration");
  await put(source, "config/config/server.yaml", { port: 30444, auth: { "X-Fixture": "older" } });
  await put(source, "config/server.yaml", { port: 30222, auth: { "X-Fixture": "private-fixture" }, https: false });
  await put(source, "config/config/milky.yaml", {
    enable: true, host: "https://remote-gateway.example.invalid", port: 31001, prefix: "/origin", access_token: "fixture-milky-secret",
  });
  await put(source, "config/config/redis.yaml", {
    host: "remote-store.example.invalid", port: 32002, username: "fixture", password: "fixture-store-secret", db: 6, path: "script",
  });
  await put(stage, "config/group.yaml", "keep: true\n");
  const result = await stageLegacyNetworkConfig(source, stage);
  expect(result).toEqual({ groups: ["server", "milky", "redis"], deferred: [] });
  expect(JSON.stringify(result)).not.toMatch(/private-fixture|secret|example\.invalid/u);
  const root = pathToFileURL(stage + "/");
  expect((await readServerSettings(root, {})).http?.port).toBe(30222);
  expect((await readMilkySettings(root))?.apiBase.pathname).toBe("/origin/api/");
  const redis = await readStorageConnection(root);
  expect(redis).toMatchObject({ host: "remote-store.example.invalid", port: 32002, database: 6, password: "fixture-store-secret" });
  for (const group of result.groups) expect((await lstat(join(stage, "config", group + ".yaml"))).mode & 0o777).toBe(0o600);
  expect(await readdir(stage)).toEqual(["config"]);
  expect(await readFile(join(stage, "config/group.yaml"), "utf8")).toBe("keep: true\n");
  await expect(lstat(join(stage, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(source, "config/config/server.yaml"), "utf8")).toContain("30444");
});

test("materializes omitted network defaults and replaces whole legacy sections before opening the host settings", async () => {
  const { source, stage } = await setup();
  const auth = { Authorization: "Bearer effective-loopback-only" };
  await put(source, "config/default_config/server.yaml", {
    port: 0, url: "https://bot.example.invalid/base", redirect: "https://docs.example.invalid/",
    auth: { "X-Legacy-Default": "not-effective" }, https: { key: "unread.pem", cert: "unread.pem", port: 42533 },
  });
  await put(source, "config/config/server.yaml", { auth, https: null });
  await put(source, "config/default_config/milky.yaml", {
    enable: true, host: "127.0.0.1", port: 32001, prefix: "/inherited", connection: "ws",
    access_token: "fixture-default-milky", http_timeout: 2.5, webhook: { path: "/inherited-hook" },
    ws: { heartbeat: 7, reconnect_interval: 4 },
  });
  await put(source, "config/config/milky.yaml", { ws: { heartbeat: 2 } });
  await put(source, "config/default_config/redis.yaml", {
    host: "127.0.0.1", port: 32002, username: "fixture-acl", password: "fixture-private-store",
    db: 11, path: "must-not-start",
  });

  const report = await stageLegacyNetworkConfig(source, stage);
  expect(report).toEqual({ groups: ["server", "milky", "redis"], deferred: [] });
  expect(JSON.stringify(report)).not.toMatch(/fixture|effective-loopback|example\.invalid/u);
  const root = pathToFileURL(stage + "/");
  const settings = await readServerSettings(root, {});
  expect(settings.http?.port).toBe(0);
  expect(settings.oneBot?.port).toBe(0);
  expect(Object.fromEntries(settings.http!.auth)).toEqual({ authorization: auth.Authorization });
  expect(settings.https).toBeUndefined();
  expect(settings.publicUrl?.pathname).toBe("/base/");
  expect(settings.redirect).toBe("https://docs.example.invalid/");
  const server = Bun.serve({ hostname: "127.0.0.1", port: settings.http!.port, fetch: httpStatus(settings.http!.auth) });
  try {
    const url = new URL("/status", server.url);
    url.searchParams.set("Authorization", auth.Authorization);
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: auth })).status).toBe(200);
  } finally {
    server.stop(true);
  }
  const milky = await readMilkySettings(root);
  expect(milky?.apiBase.href).toBe("http://127.0.0.1:32001/inherited/api/");
  expect(milky).toMatchObject({ accessToken: "fixture-default-milky", timeoutMs: 2_500, heartbeatMs: 2_000,
    reconnectMs: 10_000, webhookPath: "/inherited-hook" });
  expect(await readStorageConnection(root)).toEqual({
    host: "127.0.0.1", port: 32002, username: "fixture-acl", password: "fixture-private-store", database: 11,
  });
  for (const group of report.groups) expect((await lstat(join(stage, "config", group + ".yaml"))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(stage, "config/redis.yaml"), "utf8")).not.toContain("must-not-start");
});

test("removing inherited auth permits internal OneBot and defers unauthenticated Milky Webhook", async () => {
  const { source, stage } = await setup();
  await put(source, "config/default_config/server.yaml", { port: 0, auth: { Authorization: "Bearer discarded" } });
  await put(source, "config/config/server.yaml", { auth: null });
  await put(source, "config/default_config/milky.yaml", { enable: true, connection: "webhook", access_token: "discarded" });
  await put(source, "config/config/milky.yaml", { access_token: "" });
  expect(await stageLegacyNetworkConfig(source, stage)).toEqual({ groups: ["server"], deferred: [
    "milky.webhook.authorization",
  ] });
  const settings = await readServerSettings(pathToFileURL(stage + "/"), {});
  expect(settings.http?.port).toBe(0);
  expect(settings.http?.auth.has("Authorization")).toBe(false);
  expect(settings.oneBot?.port).toBe(0);
  expect(await Bun.file(join(stage, "config/milky.yaml")).exists()).toBe(false);
});

test.skipIf(!Bun.which("openssl"))("restores an independent matching TLS pair, resolves staged relative paths and serves trusted loopback TLS", async () => {
  const { source, stage } = await setup();
  const original = certificate(source, "original");
  await put(source, "config/server.yaml", { port: 0, auth: { Authorization: "Bearer synthetic-token" },
    https: { port: 0, key: original.key, cert: "original-cert.pem", url: "https://localhost/proxy" } });
  await put(source, "config/milky.yaml", { enable: false, host: "service.example.invalid" });
  const result = await stageLegacyNetworkConfig(source, stage);
  expect(result).toEqual({ groups: ["server", "milky"], deferred: [] });
  const settings = await readServerSettings(pathToFileURL(stage + "/"), {});
  const https = settings.https!;
  expect(https.key).toBe("config/tls/legacy-server-key.pem");
  expect(https.cert).toBe("config/tls/legacy-server-cert.pem");
  expect(https.publicUrl?.pathname).toBe("/proxy/");
  const [key, cert] = await Promise.all([readFile(join(stage, https.key)), readFile(join(stage, https.cert))]);
  expect(key.equals(await readFile(original.key))).toBe(true);
  expect(cert.equals(await readFile(original.cert))).toBe(true);
  expect((await lstat(join(stage, https.key))).mode & 0o777).toBe(0o600);
  expect((await lstat(join(stage, https.cert))).mode & 0o777).toBe(0o600);
  const server = Bun.serve({ hostname: "127.0.0.1", port: https.port, tls: { key, cert }, fetch: httpStatus(https.auth) });
  try {
    const url = new URL("/status", server.url);
    expect((await fetch(url, { tls: { ca: cert } })).status).toBe(401);
    expect((await fetch(url, { tls: { ca: cert }, headers: https.auth })).status).toBe(200);
  } finally {
    server.stop(true);
  }
});

test.skipIf(!Bun.which("openssl"))("leaves unsafe, invalid and same-port TLS configurations deferred without copying key data", async () => {
  const { directory, source } = await setup();
  const first = certificate(source, "one");
  const second = certificate(source, "two");
  const outside = certificate(directory, "outside");
  await symlink(outside.key, join(source, "linked.pem"));
  await link(first.key, join(source, "hard-linked.pem"));
  const cases = [
    { key: outside.key, cert: first.cert, tlsPort: 43433, code: "server.https.unsafe-files" },
    { key: "linked.pem", cert: first.cert, tlsPort: 43433, code: "server.https.unsafe-files" },
    { key: "hard-linked.pem", cert: first.cert, tlsPort: 43433, code: "server.https.unsafe-files" },
    { key: first.cert, cert: first.cert, tlsPort: 43433, code: "server.https.unsafe-files" },
    { key: second.key, cert: first.cert, tlsPort: 43433, code: "server.https.invalid-key-pair" },
    { key: "missing.pem", cert: first.cert, tlsPort: 43222, code: "server.https.port-collision" },
  ] as const;
  for (const [index, item] of cases.entries()) {
    const stage = join(directory, "stage-" + index);
    await mkdir(stage);
    await put(source, "config/config/server.yaml", { port: 43222, auth: { Authorization: "Bearer synthetic-token" },
      https: { key: item.key, cert: item.cert, port: item.tlsPort } });
    expect(await stageLegacyNetworkConfig(source, stage)).toEqual({ groups: ["server"], deferred: [item.code] });
    expect((await readServerSettings(pathToFileURL(stage + "/"), {})).http?.port).toBe(43222);
    await expect(lstat(join(stage, "config/tls"))).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test("refuses configuration and staging links, respects cancellation and does not overwrite or keep partial files", async () => {
  const { directory, source, stage } = await setup();
  const external = join(directory, "external");
  await put(external, "server.yaml", "port: 12345\n");
  await put(source, "config/config/server.yaml", "port: 0\n");
  await symlink(join(external, "server.yaml"), join(source, "config/server.yaml"));
  await expect(stageLegacyNetworkConfig(source, stage)).rejects.toThrow("副本中的普通 YAML");
  await rm(join(source, "config/server.yaml"));
  await symlink(external, join(stage, "config"));
  await expect(stageLegacyNetworkConfig(source, stage)).rejects.toThrow("暂存目录须为实体目录");
  expect(await readdir(external)).toEqual(["server.yaml"]);
  await rm(join(stage, "config"));
  const controller = new AbortController();
  controller.abort(new Error("aborted fixture"));
  await expect(stageLegacyNetworkConfig(source, stage, controller.signal)).rejects.toThrow("aborted fixture");
  await put(source, "config/milky.yaml", "enable: false\n");
  await put(stage, "config/milky.yaml", "already present\n");
  await expect(stageLegacyNetworkConfig(source, stage)).rejects.toMatchObject({ code: "EEXIST" });
  await expect(lstat(join(stage, "config/server.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(stage, "config/milky.yaml"), "utf8")).toBe("already present\n");
  await expect(stageLegacyNetworkConfig(source, source)).rejects.toThrow("之外的独立目录");
});
