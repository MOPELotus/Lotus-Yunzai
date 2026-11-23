import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { migrationArguments } from "../lib/migration-trss-wish.ts";
import { wishDailyKey, wishDayMs, wishDayStart, wishRetentionDays } from "../plugins/genshin/wish-sim/store.ts";
import { preflightMigration } from "../scripts/migrate-plan.ts";
import { stageMigration } from "../scripts/migrate-stage.ts";
import { migrateInstallation } from "../scripts/migrate.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const valkey = Bun.which("valkey-server");
const git = Bun.which("git");

test.skipIf(!valkey || !git)("宿主按显式授权预检和一次迁移旧限抽，目标启动后双协议生效", async () => {
  const root = await mkdtemp(join(tmpdir(), "migration-trss-wish-"));
  const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = socket.port;
  socket.stop(true);
  const server = Bun.spawn([valkey!, "--bind", "127.0.0.1", "--port", String(port),
    "--dir", root, "--save", "", "--appendonly", "no"], { stdout: "ignore", stderr: "ignore" });
  let admin: InstanceType<typeof Bun.RedisClient> | undefined;
  try {
    for (let attempt = 0; attempt < 100 && !admin; attempt++) {
      const client = new Bun.RedisClient(`redis://127.0.0.1:${port}/3`, { autoReconnect: false });
      try { await client.connect(); admin = client; } catch { client.close(); await Bun.sleep(20); }
    }
    if (!admin) throw new Error("隔离 Valkey 实例未启动。");

    const source = join(root, "source");
    const oldConfig = "plugins/genshin/config/gacha.set.yaml";
    const oldSettings = "default: { count: 2, LimitSeparate: 0, delMsg: 1 }\n";
    await mkdir(dirname(join(source, oldConfig)), { recursive: true });
    await writeFile(join(source, oldConfig), oldSettings);
    await mkdir(join(source, "config"));
    const unrelatedRedis = "host: 192.0.2.10\nport: 6379\npassword: fixture-unrelated\ndb: 2\n";
    await writeFile(join(source, "config/redis.yaml"), unrelatedRedis);

    const plain = join(root, "plain"), target = join(root, "selected");
    for (const entry of [plain, target]) {
      await mkdir(join(entry, "plugins/system"), { recursive: true });
      await mkdir(join(entry, "plugins/genshin"), { recursive: true });
      await writeFile(join(entry, "package.json"), '{"name":"lotus-yunzai"}\n');
      await writeFile(join(entry, "plugins/system/package.json"), '{"name":"@lotus-yunzai/system"}\n');
      await writeFile(join(entry, "plugins/genshin/package.json"), '{"name":"@lotus-yunzai/genshin"}\n');
      for (const args of [["init", "-q"], ["add", "package.json", "plugins"],
        ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
        expect(Bun.spawnSync([git!, ...args], { cwd: entry, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
      }
    }

    const keys = ["Yz:genshin:gacha:50:42", "Yz:genshin:gacha:50:43"];
    await admin.send("ACL", ["SETUSER", "trss-reader", "on", ">trss-fixture",
      "~" + keys[0], "+get", "+pexpiretime", "+select", "+hello", "+client"]);
    const sourceUrl = `redis://trss-reader:trss-fixture@127.0.0.1:${port}/3`;
    const authorizationFile = join(root, "authorization.json");
    const argumentsWithSnapshot = [source, "--trss-wish-authorization", authorizationFile];

    // Ambient settings alone leave the default CLI path unchanged.
    expect(migrationArguments([source], sourceUrl)).toEqual({ source, inputs: {} });
    expect(migrationArguments([source, "--trss-wish-authorization"], sourceUrl)).toBeUndefined();
    expect(await preflightMigration(source, plain, migrationArguments([source], sourceUrl)!.inputs)).not.toHaveProperty("trssWish");
    expect(await migrateInstallation(source, plain)).toMatchObject({ status: "published", genshinWish: { active: true } });
    expect(await Bun.file(join(plain, "data/genshin/wish-sim/42/1.json")).exists()).toBe(false);

    let capturedAt = Date.now();
    const toReset = wishDayStart(wishDailyKey(capturedAt) + 1) - capturedAt;
    if (toReset < 4000) await Bun.sleep(toReset + 1600);
    else if (capturedAt - wishDayStart(wishDailyKey(capturedAt)) < 1600) await Bun.sleep(1800);
    capturedAt = Date.now();
    const day = wishDailyKey(capturedAt), start = wishDayStart(day), hour = 3_600_000;
    const midnight = start + 20 * hour;
    let lastSaved = capturedAt - 250;
    if (lastSaved >= midnight && lastSaved < midnight + hour) lastSaved = midnight - 1_000;
    const expire = (start + wishDayMs) / 1000 - Number(lastSaved < midnight + hour);
    const ttlAt = lastSaved + wishRetentionDays * wishDayMs;
    const localSaved = new Date(lastSaved + 8 * hour);
    const legacyWeekEnd = Date.UTC(localSaved.getUTCFullYear(), localSaved.getUTCMonth(),
      localSaved.getUTCDate() + 7 - localSaved.getUTCDay(), 23, 59, 59) - 8 * hour;
    const stars = [
      [{ name: "隔离原神角色甲", num: 77 }, { name: "隔离原神角色乙", num: 3 }],
      Array.from({ length: 4 }, (_, index) => ({ name: `隔离另一账号角色${index}`, num: 1 })),
    ];
    const oldValues = stars.map(star => JSON.stringify({ today: { expire, num: 20, weaponNum: 0, star },
      week: { expire: legacyWeekEnd / 1000, num: star.length + 2 }, role: { num5: 89 } }));
    await Promise.all(keys.map((key, index) => admin!.send("SET", [key, oldValues[index]!, "PXAT", String(ttlAt)])));
    const authText = JSON.stringify({ source: "trss-genshin-0290a17", timeZone: "Asia/Shanghai", capturedAt,
      accounts: [{ qq: "42", conversations: ["50"] }, { qq: "43", conversations: ["50"] }] });
    await writeFile(authorizationFile, authText, { mode: 0o600 });
    const { inputs } = migrationArguments(argumentsWithSnapshot, sourceUrl)!;

    // A retry cannot silently drop new input by reusing a previously prepared transaction without it.
    await expect(migrateInstallation(source, plain, undefined, inputs)).rejects.toThrow("现有迁移暂存未包含");
    const initialTarget = (await readdir(target)).sort();
    const siblings = (await readdir(root)).sort();
    const missingAddress = migrationArguments(argumentsWithSnapshot)!.inputs;
    await expect(stageMigration(source, target, undefined, missingAddress)).rejects.toThrow("LOTUS_GENSHIN_TRSS_WISH_SNAPSHOT_URL");
    expect((await readdir(root)).sort()).toEqual(siblings);
    expect((await preflightMigration(source, target, inputs)).trssWish).toMatchObject({ carried: 1, unavailable: 1 });
    await expect(stageMigration(source, target, undefined, inputs)).rejects.toThrow("1 个已授权的旧 TRSS 限抽会话无法读取");
    expect((await readdir(target)).sort()).toEqual(initialTarget);
    expect((await readdir(root)).sort()).toEqual(siblings);
    await expect(migrateInstallation(source, target, undefined, inputs)).rejects.toThrow("已授权的旧 TRSS 限抽会话无法读取");
    await expect(stat(join(root, ".selected.lotus-migration-prepared"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(target)).sort()).toEqual(initialTarget);
    const retrySiblings = (await readdir(root)).sort();
    await admin.send("ACL", ["SETUSER", "trss-reader", "~" + keys[1]]);
    const preview = await preflightMigration(source, target, inputs);
    expect(preview).toMatchObject({ mode: "dry-run", trssWish: { accounts: 2, carried: 2 } });
    expect(JSON.stringify(preview)).not.toContain("trss-fixture");
    expect((await readdir(target)).sort()).toEqual(initialTarget);
    expect((await readdir(root)).sort()).toEqual(retrySiblings);

    const archive = "data/genshin/wish-sim";
    const stage = await stageMigration(source, target, undefined, inputs);
    expect(stage.trssWish).toEqual(preview.trssWish);
    expect(await Bun.file(join(target, archive, "42/1.json")).exists()).toBe(false);
    expect((await stat(join(stage.state.directory, archive, "42/1.json"))).mode & 0o777).toBe(0o600);
    await rm(stage.directory, { recursive: true, force: true });
    const outcome = await migrateInstallation(source, target, undefined, inputs);
    expect(outcome).toMatchObject({ status: "published", paths: ["config", "data"], trssWish: preview.trssWish });
    expect(await readFile(join(source, oldConfig), "utf8")).toBe(oldSettings);
    expect(await readFile(join(source, "config/redis.yaml"), "utf8")).toBe(unrelatedRedis);
    expect(await readFile(authorizationFile, "utf8")).toBe(authText);
    for (const [index, qq] of ["42", "43"].entries()) {
      const file = join(target, archive, qq, "1.json");
      expect(await Bun.file(file).json()).toMatchObject({ balance: { day: 0, blue: 0, pink: 0 }, conversations: {},
        trssLimits: { 50: { day, normalDraws: 20, weaponDraws: 0 } } });
      expect(await admin.get(keys[index]!)).toBe(oldValues[index]!);
      expect(await admin.send("PEXPIRETIME", [keys[index]!])).toBe(ttlAt);
    }
    const receipt = await readFile(join(root, ".selected.lotus-migration-prepared/plan.json"), "utf8");
    expect(receipt).not.toContain(sourceUrl);
    expect(receipt).not.toContain(authorizationFile);
    await rm(authorizationFile);
    admin.close();
    admin = undefined;
    server.kill();
    await server.exited;
    expect(await migrateInstallation(source, target, undefined, missingAddress)).toMatchObject({
      status: "already-published", trssWish: preview.trssWish,
    });

    await withDualGatewayFixture("isolated-trss-wish", "disablePrivate: false\n", async ({ root: host, sendOneBot, sendMilky, onebot, milky }) => {
      sendOneBot("#十连", { message_type: "group", sub_type: "normal", group_id: 50, sender: { user_id: 42 } });
      const oneAllowance = await onebot.next("send_msg");
      expect(oneAllowance.params).toMatchObject({ group_id: 50, message: "今日成功领取100个纠缠之缘和10个相遇之缘。" });
      oneAllowance.respond({ message_id: 900 });
      const first = await onebot.next("send_msg");
      expect(first.params.group_id).toBe(50);
      expect(JSON.stringify(first.params.message)).toContain("已达到 20 抽上限");
      expect(first.params.message).toMatch(/隔离原神角色甲\(77\)[\s\S]*隔离原神角色乙\(3\)[\s\S]*本周：4个五星/u);
      first.respond({ message_id: 901 });
      const oneRecall = await onebot.next("delete_msg");
      expect(oneRecall.params).toEqual({ message_id: 901 });
      oneRecall.respond({});
      const sent = await sendMilky("#十连", { message_scene: "group", peer_id: 50 });
      expect(sent.status).toBe(200);
      const milkyAllowance = await milky.next("send_group_message");
      expect(milkyAllowance.params.group_id).toBe(50);
      expect(JSON.stringify(milkyAllowance.params.message)).toContain("今日成功领取100个纠缠之缘和10个相遇之缘。");
      milkyAllowance.respond({ message_seq: 903 });
      const second = await milky.next("send_group_message");
      expect(second.params.group_id).toBe(50);
      expect(JSON.stringify(second.params.message)).toContain("已达到 20 抽上限");
      expect(JSON.stringify(second.params.message)).toContain("今日五星：4个");
      expect(JSON.stringify(second.params.message)).toContain("本周：6个五星");
      expect(JSON.stringify(second.params.message)).not.toContain("隔离原神角色甲");
      second.respond({ message_seq: 902 });
      const milkyRecall = await milky.next("recall_group_message");
      expect(milkyRecall.params).toEqual({ group_id: 50, message_seq: 902 });
      milkyRecall.respond({});

      const config = join(host, "config/genshin-wish.yaml");
      const values = Bun.YAML.parse(await readFile(config, "utf8")) as Record<string, unknown>;
      await writeFile(config, Bun.YAML.stringify({
        ...values, recallSeconds: 0, dailyDrawLimits: { default: { count: 0, separate: true } },
      }));
      sendOneBot("#武器单抽", { message_type: "group", sub_type: "normal", group_id: 50, sender: { user_id: 42 } });
      const hot = await onebot.next("send_msg");
      expect(hot.params.message).toContain("武器池已达到 0 抽上限");
      hot.respond({ message_id: 911 });
      await Bun.sleep(1_100);
      expect(onebot.calls).toHaveLength(0);
    }, 2_000, `
const actualFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "127.0.0.1") throw Error("isolated migration fixture");
  return actualFetch(input, options);
};
`, async host => {
      const plugin = join(import.meta.dir, "../plugins/genshin");
      const installed = join(host, "plugins/genshin");
      await cp(plugin, installed, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
      await symlink(join(plugin, "node_modules"), join(installed, "node_modules"), "dir");
      await symlink(join(import.meta.dir, "../packages"), join(host, "packages"), "dir");
      await cp(join(target, "config/genshin-wish.yaml"), join(host, "config/genshin-wish.yaml"));
      await mkdir(join(host, archive), { recursive: true });
      await cp(join(target, archive), join(host, archive), { recursive: true });
    });
  } finally {
    admin?.close();
    server.kill();
    await server.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
