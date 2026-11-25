import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";

const valkeyServer = Bun.which("valkey-server");
const key = "yenai:MuteTasks";
const scripts = ["scripts/prepare-legacy-mute-tasks.ts", "lib/valkey-config.ts", "lib/config.ts", "lib/file-lock.ts",
  "plugins/group/group-timed-mute.ts", "lib/i18n-preload.ts", "packages/i18n/index.ts",
  "i18n/zh-CN.json", "plugins/group/i18n/zh-CN.json"];

test.skipIf(!valkeyServer)("定时群禁言交还离线预览，原值吻合才更新并保留绝对过期时间", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-mute-handoff-"));
  const root = join(temporary, "checkout");
  const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = reservation;
  reservation.stop(true);
  const valkey = Bun.spawn([valkeyServer!, "--bind", "127.0.0.1", "--port", String(port),
    "--save", "", "--appendonly", "no", "--dir", temporary], { stdout: "ignore", stderr: "ignore" });
  const redisUrl = `redis://127.0.0.1:${port}/6`;
  const redis = new Bun.RedisClient(redisUrl, { autoReconnect: false });
  const state = JSON.stringify({ version: 1, tasks: [
    { groupId: 77, enabled: true, botId: 99, issuerId: 51, adapter: "milky", cron: "0 8 7 * * ?" },
  ], retiredLegacy: [{ groupId: 77, enabled: true }, { groupId: 78, enabled: false }] });
  const keep = { cron: "0 8 9 * * ?", group: "79", type: false, botId: "101", comment: "原字段" };
  const legacy = JSON.stringify([
    { cron: "0 8 7 * * ?", group: "77", type: true, botId: 99 },
    { cron: "0 8 8 * * ?", group: 78, type: false, botId: "99" }, keep,
  ], null, 2);
  const filtered = JSON.stringify([keep]);
  const modern = join(temporary, "modern.json");
  const original = join(temporary, "legacy.json");
  async function execute(apply = false) {
    const command = Bun.spawn([process.execPath, "--no-env-file", scripts[0]!,
      ...(apply ? ["--apply"] : []), modern, original], {
      cwd: root, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, LOTUS_VALKEY_URL: apply ? redisUrl : "unreachable" },
    });
    const [code, stdout, stderr] = await Promise.all([
      command.exited, new Response(command.stdout).text(), new Response(command.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }
  try {
    for (const directory of ["scripts", "lib", "plugins/group/i18n", "packages/i18n", "i18n"])
      await mkdir(join(root, directory), { recursive: true });
    await Promise.all([
      ...scripts.map(file => cp(new URL(`../${file}`, import.meta.url), join(root, file))),
      symlink(new URL("../node_modules", import.meta.url).pathname, join(root, "node_modules"), "dir"),
      writeFile(modern, state), writeFile(original, legacy),
    ]);
    const preview = await execute();
    if (preview.code !== 0) throw new Error(preview.stderr || preview.stdout);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toEqual({ mode: "dry-run", removed: 2, changed: false });
    for (let trial = 0; trial < 50 && !redis.connected; trial++) {
      await redis.connect().catch(() => {});
      if (!redis.connected) await Bun.sleep(20);
    }
    expect(redis.connected).toBe(true);
    await redis.send("SET", [key, "changed", "PX", "60000"]);
    const deadline = await redis.send("PEXPIRETIME", [key]);
    const conflict = await execute(true);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain("旧定时群禁言键已变化");
    expect(await redis.get(key)).toBe("changed");
    await redis.send("SET", [key, legacy, "XX", "KEEPTTL"]);

    const lock = await lockFile(join(temporary, ".checkout.lotus-host.sqlite"), "隔离启动测试", 0);
    try {
      const occupied = await execute(true);
      expect(occupied.code).toBe(1);
      expect(occupied.stderr).toContain("请先停止托管宿主");
      expect(await redis.get(key)).toBe(legacy);
    } finally {
      lock.close();
    }
    const applied = await execute(true);
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout)).toEqual({ mode: "apply", removed: 2, changed: true });
    expect(await redis.get(key)).toBe(filtered);
    expect(await redis.send("PEXPIRETIME", [key])).toBe(deadline);
    const retry = await execute(true);
    expect(retry.code).toBe(0);
    expect(JSON.parse(retry.stdout)).toMatchObject({ changed: false });
    expect(await redis.send("PEXPIRETIME", [key])).toBe(deadline);
    expect(await readFile(modern, "utf8")).toBe(state);
    expect(await readFile(original, "utf8")).toBe(legacy);
  } finally {
    redis.close();
    valkey.kill();
    await valkey.exited;
    await rm(temporary, { recursive: true, force: true });
  }
}, 15_000);
