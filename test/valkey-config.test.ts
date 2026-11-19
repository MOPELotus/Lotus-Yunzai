import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readStorageConnection } from "../lib/valkey-config.ts";

test("显式 Valkey URL 优先，旧 Redis 配置保留凭据并支持 IPv6", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-valkey-config-"));
  const root = pathToFileURL(directory + "/");
  try {
    expect(await readStorageConnection(root)).toBeUndefined();
    await mkdir(new URL("config/config/", root), { recursive: true });
    await writeFile(new URL("config/config/redis.yaml", root), [
      "host: '[::1]'", "port: '6380'", "db: '3'", "username: 'acl@fixture'", "password: 'a:%+?# b'",
    ].join("\n"));
    expect(await readStorageConnection(root)).toEqual({
      host: "::1", port: 6380, database: 3, username: "acl@fixture", password: "a:%+?# b",
    });
    const primary = new URL("config/redis.yaml", root);
    await writeFile(primary, "path: /fixture/redis-server\nusername:\npassword: ''\n");
    expect(await readStorageConnection(root)).toMatchObject({ host: "127.0.0.1", port: 6379, database: 0 });
    await writeFile(primary, "host: https://fixture.invalid/path\n");
    await expect(readStorageConnection(root)).rejects.toThrow("redis.yaml 的 host");
    expect(await readStorageConnection(root, "")).toBe("");
    expect(await readStorageConnection(root, "rediss://fixture.invalid")).toBe("rediss://fixture.invalid");

    for (const [key, value] of [["port", 65536], ["db", -1], ["username", {}], ["password", 123]]) {
      await writeFile(primary, JSON.stringify({ [String(key)]: value }));
      await expect(readStorageConnection(root)).rejects.toThrow(`redis.yaml 的 ${key}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
