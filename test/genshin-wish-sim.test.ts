import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { importLegacyWishes } from "../plugins/genshin/wish-sim/legacy-import.ts";
import { createWishCommands } from "../plugins/genshin/wish-sim/commands.ts";
import { drawWish, emptySession, prepareWeaponPath } from "../plugins/genshin/wish-sim/draw.ts";
import { createWishPoolSource } from "../plugins/genshin/wish-sim/pools.ts";

const time = Date.parse("2026-09-06T16:00:00+08:00");
const poolSource = createWishPoolSource({ themeDirectory: "/nonexistent", legacyDirectory: "" });

test("Flower hard pity, shared character pools and weapon rotation", async () => {
  const [role, role2, permanent, weapon] = await Promise.all(
    (["role", "role2", "permanent", "weapon"] as const).map((kind) => poolSource(kind, time)),
  );
  const state = emptySession(1);
  state.role.num5 = 88;
  state.role.isUp5 = true;
  expect(drawWish(role!, state, 1, () => 0.999)).toMatchObject([{ star: 3 }]);
  expect(drawWish(role2!, state, 1, () => 0.999)).toEqual([
    { name: "伊涅芙", type: "role", star: 5, at: 1, pity: 90, guaranteed: "大保底" },
  ]);
  expect(state.permanent.num5).toBe(0);
  expect(drawWish(permanent!, state, 1, () => 0.999)).toMatchObject([{ star: 3 }]);

  prepareWeaponPath(state.weapon, weapon!);
  state.weapon.num5 = 79;
  state.weapon.lifeNum = 1;
  expect(drawWish(weapon!, state, 1, () => 0.999)).toMatchObject([
    { name: "血染荒城", star: 5, pity: 80, guaranteed: "定轨" },
  ]);
  expect(state.weapon.lifeNum).toBe(0);
  prepareWeaponPath(state.weapon, { ...weapon!, rotation: "next" });
  expect(state.weapon.target).toBeUndefined();
});

test("accepts Flower draw commands and keeps daily allowance atomic across conversations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-wish-test-"));
  let clock = Date.parse("2026-09-06T03:59:59+08:00");
  const signal = new AbortController().signal;
  const create = () => createWishCommands({
    lockFile, signal, storeDirectory: dir, poolSource, now: () => clock,
    random: () => 0.99, render: async () => { throw new Error("test text reply"); },
  });
  const command = create();
  const user = { user_id: 333 };
  try {
    expect(await command("#武器十连常驻非法", user)).toBeUndefined();
    expect(await command("#原神抽卡记录2", user)).toBeUndefined();
    expect(await command("#星铁十连", user)).toBeUndefined();
    expect(await command("#定轨2", user)).toContain("[√] 支离轮光");
    expect(await command("#定轨查询", user)).toContain("支离轮光");
    const replies = await Promise.all([
      command("#常驻十连", user), create()("#十连常驻", { ...user, group_id: 334 }),
    ]);
    expect(replies.filter((reply) => typeof reply === "string" && reply.includes("相遇之缘不足"))).toHaveLength(1);
    expect(await command("#查看蓝球", user)).toContain("0个相遇之缘");
    clock += 1_000;
    expect(await create()("#查看蓝球", user)).toContain("今日成功领取100个纠缠之缘和10个相遇之缘");
    expect(await command("#单抽2", user)).toContain("角色池 · 伊涅芙");
    expect(await command("#百连", user)).toContain("需要100个，你还有99个");
    const archive = JSON.parse(await readFile(join(dir, "333", "1.json"), "utf8"));
    expect(archive.conversations.private.session.role.num5).toBe(1);
    expect(archive.conversations.private.session.weapon.target).toBe("支离轮光");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createLegacyDirectory(root: string) {
  const legacyDirectory = join(root, "flower");
  await mkdir(join(legacyDirectory, "def"), { recursive: true });
  await copyFile(new URL("../plugins/genshin/wish-sim/flower/pool.yaml", import.meta.url), join(legacyDirectory, "def", "pool.yaml"));
  await mkdir(join(legacyDirectory, "config"), { recursive: true });
  return legacyDirectory;
}

test("Flower 旧池按同步开关和个人数据读取，并在下一次查询应用新文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-wish-flower-pool-"));
  try {
    const legacyDirectory = await createLegacyDirectory(dir);
    const factory = createWishPoolSource({ legacyDirectory, bannerFile: "" });
    const defaults = await readFile(join(legacyDirectory, "def", "pool.yaml"), "utf8");
    await writeFile(join(legacyDirectory, "config", "pool.yaml"), defaults.replace("血染荒城", "本地定制武器"));
    await writeFile(join(legacyDirectory, "config", "gacha.yaml"), "sync: true\n");
    expect((await factory("weapon", time))?.up5[0]?.name).toBe("血染荒城");
    await writeFile(join(legacyDirectory, "config", "gacha.yaml"), "sync: false\n");
    expect((await factory("weapon", time))?.up5[0]?.name).toBe("本地定制武器");
    await mkdir(join(legacyDirectory, "data", "777"), { recursive: true });
    await writeFile(join(legacyDirectory, "data", "777", "pool.yaml"), defaults.replace("血染荒城", "个人定制武器"));
    expect((await factory("weapon", time, "777"))?.up5[0]?.name).toBe("个人定制武器");
    await writeFile(join(legacyDirectory, "config", "gacha.yaml"), "sync: true\n");
    await writeFile(join(legacyDirectory, "def", "pool.yaml"), defaults.replace("血染荒城", "下一期武器"));
    expect((await factory("weapon", time))?.up5[0]?.name).toBe("下一期武器");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const valkey = Bun.which("valkey-server");
test.skipIf(!valkey)("预检和导入仅从旧 Valkey 读取授权键，保底续接且重复导入不回滚", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-wish-migrate-"));
  const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = socket.port;
  socket.stop(true);
  const server = Bun.spawn([valkey!, "--bind", "127.0.0.1", "--port", String(port),
    "--dir", root, "--save", "", "--appendonly", "no"], { stdout: "ignore", stderr: "ignore" });
  const sourceUrl = `redis://127.0.0.1:${port}/3`;
  let admin: InstanceType<typeof Bun.RedisClient> | undefined;
  try {
    for (let attempt = 0; attempt < 100 && !admin; attempt++) {
      const client = new Bun.RedisClient(sourceUrl, { autoReconnect: false });
      try { await client.connect(); admin = client; } catch { client.close(); await Bun.sleep(20); }
    }
    if (!admin) throw new Error("隔离 Valkey 实例未启动。");
    await admin.send("ACL", ["SETUSER", "flower-reader", "on", ">read-fixture",
      "~Yz:flower-plugin:coin:444", "~Yz:flower-plugin:coin:445", "~Yz:flower-plugin:gacha:private:444",
      "~Yz:flower-plugin:gacha:private:445", "~Yz:flower-plugin:gacha:666:444",
      "+get", "+pttl", "+select", "+hello", "+client"]);
    const readUrl = `redis://flower-reader:read-fixture@127.0.0.1:${port}/3`;

    const auth = join(root, "authorized.json");
    const destination = join(root, "destination");
    const legacyDirectory = await createLegacyDirectory(root);
    const signals = new AbortController();
    await writeFile(auth, JSON.stringify([{ qq: "444", groups: ["666"] }, { qq: "445" }]));
    const time = Date.parse("2026-09-03T16:00:00+08:00");
    const expiry = Date.parse("2026-09-04T03:59:59+08:00") / 1000;
    const weekEnds = Date.parse("2026-09-06T23:59:59+08:00") / 1000;
    const normal = { num4: 3, num5: 4, isUp4: 0, isUp5: 0 };
    const legacy = {
      role: { ...normal, num5: 89, isUp5: 1 },
      permanent: normal,
      weapon: { ...normal, num5: 79, lifeNum: 1, type: 2, bingWeapon: "支离轮光" },
      today: { expire: expiry, star: [], num: 0, weaponNum: 0 },
      week: { expire: weekEnds, num: 1 },
    };
    const set = (key: string, value: unknown, seconds: number) =>
      admin!.send("SET", [`Yz:flower-plugin:${key}`, JSON.stringify(value), "EX", String(seconds)]);
    await Promise.all([
      set("coin:444", { expire: expiry, pink: 13, blue: 2 }, 86_400),
      set("coin:445", { expire: expiry - 86_400, pink: 1, blue: 1 }, 86_400),
      set("gacha:private:444", legacy, 14 * 86_400),
      set("gacha:666:444", { ...legacy, role: normal }, 14 * 86_400),
      set("gacha:777:444", "限定群外", 14 * 86_400),
    ]);
    const options = { sourceUrl: readUrl, authorizationFile: auth, destinationDirectory: destination,
      legacyDirectory, now: () => time, signal: signals.signal };
    expect(await importLegacyWishes({ ...options, apply: false }, lockFile)).toEqual({
      accounts: 2, imported: 1, already: 0, empty: 1, balances: 1, sessions: 2,
    });
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });

    const applied = await Promise.all([
      importLegacyWishes({ ...options, apply: true }, lockFile),
      importLegacyWishes({ ...options, apply: true }, lockFile),
    ]);
    expect(applied.map((report) => report.imported).sort()).toEqual([0, 1]);
    expect(applied.map((report) => report.already).sort()).toEqual([0, 1]);
    expect(applied.map((report) => report.empty)).toEqual([1, 1]);
    await expect(stat(join(destination, "445"))).rejects.toMatchObject({ code: "ENOENT" });
    const command = createWishCommands({
      signal: signals.signal, lockFile, storeDirectory: destination, now: () => time,
      poolSource: createWishPoolSource({ legacyDirectory, bannerFile: "" }),
      random: () => 0.999, render: async () => { throw new Error("check text"); },
    });
    expect(await command("#我的纠缠之缘", { user_id: 444 })).toContain("还有13个纠缠之缘和2个相遇之缘");
    expect(await command("#单抽2", { user_id: 444 })).toContain("伊涅芙（90抽大保底）");
    expect(await command("#单抽武器", { user_id: 444, group_id: 666 })).toContain("支离轮光（80抽定轨）");
    const existing = await readFile(join(destination, "444", "1.json"), "utf8");
    await set("gacha:private:444", "第一次已导入后不再读取", 14 * 86_400);
    expect(await importLegacyWishes({ ...options, apply: true }, lockFile)).toMatchObject({ already: 1, imported: 0 });
    expect(await readFile(join(destination, "444", "1.json"), "utf8")).toBe(existing);
    expect(JSON.parse(existing).conversations["777"]).toBeUndefined();
    expect(await admin.get("Yz:flower-plugin:coin:444")).toBe(JSON.stringify({ expire: expiry, pink: 13, blue: 2 }));

    const nativeDestination = join(root, "native");
    const native = createWishCommands({
      signal: signals.signal, lockFile, storeDirectory: nativeDestination, now: () => time, poolSource,
      random: () => 0.999, render: async () => { throw new Error("check text"); },
    });
    expect(await native("#单抽", { user_id: 444 })).toContain("1抽未出五星");
    await set("gacha:private:444", legacy, 14 * 86_400);
    expect(await importLegacyWishes({ ...options, destinationDirectory: nativeDestination, apply: true }, lockFile))
      .toMatchObject({ imported: 1, balances: 0, sessions: 1 });
    expect(await native("#我的纠缠之缘", { user_id: 444 })).toContain("还有99个纠缠之缘");
    expect(await native("#单抽", { user_id: 444 })).toContain("2抽未出五星");

    const cli = new URL("../plugins/genshin/wish-sim/import-legacy-cli.ts", import.meta.url);
    const cliAuth = join(root, "cli-authorized.json");
    const cliDestination = join(root, "cli-destination");
    await writeFile(cliAuth, '[{"qq":"445"}]');
    await set("coin:445", { expire: Math.floor(Date.now() / 1000) + 120, pink: 7, blue: 0 }, 60);
    const preflight = Bun.spawn([process.execPath, cli.pathname, cliAuth, cliDestination], {
      env: { LOTUS_GENSHIN_WISH_LEGACY_REDIS_URL: readUrl }, stdout: "pipe", stderr: "pipe",
    });
    const [output, cliError, status] = await Promise.all([
      new Response(preflight.stdout).json(), new Response(preflight.stderr).text(), preflight.exited,
    ]);
    expect(status, cliError).toBe(0);
    expect(output).toMatchObject({ mode: "preview", imported: 1, balances: 1 });
    await expect(stat(cliDestination)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    admin?.close();
    server.kill();
    await server.exited;
    await rm(root, { recursive: true, force: true });
  }
});
