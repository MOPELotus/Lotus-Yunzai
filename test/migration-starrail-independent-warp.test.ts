import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { migrateInstallation } from "../scripts/migrate.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const executable = Bun.which("valkey-server");
const legacyPath = "plugins/StarRail-plugin/config/gccfg.yaml";

async function put(root: string, path: string, contents: string) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents);
}

test.skipIf(!executable)("普通迁移自动归档独立星铁并在真实宿主继续旧 Redis 五池和群私设置", async () => {
  const data = await mkdtemp(join(tmpdir(), "independent-warp-migration-"));
  const previous = join(data, "previous");
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  const password = crypto.randomUUID();
  const server = Bun.spawn([executable!, "--bind", "127.0.0.1", "--port", String(port), "--requirepass", password,
    "--save", "", "--appendonly", "no", "--dir", data], { stdout: "ignore", stderr: "ignore" });
  let redis: InstanceType<typeof Bun.RedisClient> | undefined;
  try {
    for (let attempt = 0; attempt < 100 && redis === undefined; attempt++) {
      const client = new Bun.RedisClient(`redis://:${password}@127.0.0.1:${port}/3`, { autoReconnect: false });
      try { await client.connect(); redis = client; }
      catch { client.close(); await Bun.sleep(20); }
    }
    if (!redis) throw new Error("独立模拟 Valkey 夹具未启动。");
    await put(previous, "package.json", '{"name":"legacy-yunzai"}');
    await put(previous, legacyPath, "limit: {group: true, private: true, count: 1}\nrecall: {enable: false}\ndisable_group: [79]\n");
    await put(previous, "plugins/StarRail-plugin/defSet/gccfg.yaml", "recall: {enable: true, time: 110}\n");
    await put(previous, "plugins/flower-plugin/GachaMOD/StarRail/config/coin.yaml", "default: {pink: 27, blue: 18}\n");
    await put(previous, "config/config/redis.yaml", `host: 127.0.0.1\nport: ${port}\npassword: ${password}\ndb: 3\n`);
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short" }).format();
    const pity = { num4: 4, num5: 62, isUp4: true, isUp5: false, today: { stars: Array.from({ length: 10 }, () => ({ star: 3 })) } };
    const oldDocument = JSON.stringify({ time: today, "up-char": { ...pity, num5: 69 }, "up-weapon": pity, normal: pity });
    await redis.set("sr-gacha:private:42", oldDocument);
    await redis.send("EXPIRE", ["sr-gacha:private:42", "885"]);
    await redis.set("sr-gacha:group:77:user:42", oldDocument);
    await redis.send("EXPIRE", ["sr-gacha:group:77:user:42", "915"]);
    const keyExpiry = await redis.send("PEXPIRETIME", ["sr-gacha:private:42"]);
    await withDualGatewayFixture("lotus-standalone-warp-fixture", "disablePrivate: false\nowner: []\n", async context => {
      context.sendOneBot("*十连");
      const privateResult = await context.onebot.next("send_msg");
      expect(privateResult.params.message).toEqual(expect.stringContaining("今日已抽 10 抽"));
      privateResult.respond({ message_id: 501 });
      context.sendOneBot("*十连光锥", { message_type: "group", sub_type: "normal", group_id: 77 });
      const groupResult = await context.onebot.next("send_msg");
      expect(groupResult.params.message).toEqual(expect.stringContaining("今日已抽 10 抽"));
      groupResult.respond({ message_id: 502 });
      context.sendOneBot("*十连", { message_type: "group", sub_type: "normal", group_id: 79 });
      const blocked = await context.onebot.next("send_msg");
      expect(blocked.params.message).toEqual(expect.stringContaining("本群已被禁用"));
      blocked.respond({ message_id: 503 });
      context.sendOneBot("*我的星轨票");
      const issuance = await context.onebot.next("send_msg");
      expect(issuance.params.message).toEqual(expect.stringContaining("27 张专票和 18 张通票"));
      issuance.respond({ message_id: 504 });
      const wallet = await context.onebot.next("send_msg");
      expect(wallet.params.message).toEqual(expect.stringContaining("27 张星轨专票和 18 张"));
      wallet.respond({ message_id: 505 });
      const file = (scope: string, id: number) => join(context.root, "data/starrail/simulation", scope, "42", `${id}.json`);
      const transferred = JSON.parse(await readFile(file("independent-private", 1), "utf8"));
      expect(transferred.expiresAt).toBe(keyExpiry);
      expect(transferred.pools.character).toMatchObject({ fiveMisses: 69, nextFourFeatured: true, draws: 10 });
      expect(JSON.parse(await readFile(file("independent-group", 77), "utf8")).pools.cone.fiveMisses).toBe(62);
      expect(await redis!.get("sr-gacha:private:42")).toBe(oldDocument);
      expect(await redis!.get("sr-gacha:group:77:user:42")).toBe(oldDocument);
      expect(await redis!.send("PEXPIRETIME", ["sr-gacha:private:42"])).toBe(keyExpiry);
      expect(await Bun.file(join(context.root, "backup", legacyPath)).text()).toContain("count: 1");
    }, 3_000, `
      Bun.env.TZ = "Asia/Shanghai";
      const network = globalThis.fetch;
      globalThis.fetch = (input, options) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.hostname !== "127.0.0.1") throw new Error("禁止测试外连");
        return network(input, options);
      };
    `, async target => {
      await put(target, "package.json", '{"name":"lotus-yunzai"}');
      await symlink(join(import.meta.dir, "../packages"), join(target, "packages"), "dir");
      const stars = join(target, "plugins/starrail");
      await cp(new URL("../plugins/starrail", import.meta.url), stars, {
        recursive: true, filter: path => !/\/(?:\.git|node_modules|test|resources|LICENSES)(?:\/|$)/u.test(path),
      });
      const commands = [["init", "-q"], ["add", "package.json", "plugins/system/package.json"],
        ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]];
      for (const args of commands) expect(Bun.spawnSync(["git", ...args], { cwd: target }).exitCode).toBe(0);
      // The real migration requires a clean managed host checkout.
      expect(Bun.spawnSync(["git", "add", "plugins/system", "plugins/starrail"], { cwd: target }).exitCode).toBe(0);
      expect(Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "commit", "-qm", "managed modules"], { cwd: target }).exitCode).toBe(0);
      await symlink(join(import.meta.dir, "../plugins/starrail/node_modules"), join(stars, "node_modules"), "dir");
      const fixtureConfig = join(data, "fixture-config");
      await rename(join(target, "config"), fixtureConfig);
      const result = await migrateInstallation(previous, target);
      await cp(fixtureConfig, join(target, "config"), { recursive: true });
      await put(target, "config/global.yaml", "scheduler: {enable: false}\ncoin_shop: {enable: false}\n");
      expect(result.starRailIndependentWarp).toEqual({ active: true, deferred: false });
      expect(result.starRailWarp).toEqual({ active: true, deferred: false });
    });
  } finally {
    redis?.close();
    server.kill();
    await server.exited;
    await rm(data, { recursive: true, force: true });
  }
}, 15_000);
