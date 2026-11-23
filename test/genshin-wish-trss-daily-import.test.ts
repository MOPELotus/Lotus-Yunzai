import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lockFile } from "../lib/file-lock.ts";
import { parseWishSettings } from "../lib/genshin-wish-settings-model.ts";
import { createWishCommands } from "../plugins/genshin/wish-sim/commands.ts";
import { emptySession } from "../plugins/genshin/wish-sim/draw.ts";
import { createWishPoolSource } from "../plugins/genshin/wish-sim/pools.ts";
import { createLegacyWishImport, wishDailyKey, wishDayMs, wishDayStart, wishRetentionDays,
  wishWeeklyKey } from "../plugins/genshin/wish-sim/store.ts";
import { importTrssWishLimits } from "../plugins/genshin/wish-sim/trss-daily-import.ts";

const valkey = Bun.which("valkey-server");

test.skipIf(!valkey)("旧 TRSS 限抽从停写的 Valkey 精确续接，日界、隔离及优先级生效", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-trss-daily-import-"));
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
    const key = (scope: string, qq = "42") => `Yz:genshin:gacha:${scope}:${qq}`;
    const authScopes = ["50", "51", "52", "53", "54", "55", "56", "57", "58", "59", "60", "61", "62"];
    const aclScopes = ["50", "51", "52", "53", "54", "55", "58", "59", "60", "61", "62", "private"];
    await admin.send("ACL", ["SETUSER", "trss-reader", "on", ">fixture-reader",
      ...aclScopes.map(scope => "~" + key(scope)), "~" + key("private", "43"),
      "+get", "+pexpiretime", "+select", "+hello", "+client"]);
    const sourceUrl = `redis://trss-reader:fixture-reader@127.0.0.1:${port}/3`;

    const hour = 3_600_000;
    const day = wishDailyKey(Date.now());
    const start = wishDayStart(day), next = start + wishDayMs;
    const retention = wishRetentionDays * wishDayMs;
    const expiry = next / 1000 - 1;
    let now = start + 6 * hour;
    const capturedAt = now - 30_000, saved = now - 60_000;
    const payload = (num: number, weaponNum: number, expire = expiry) => ({
      today: { num, weaponNum, expire, star: [{ name: "不导入的旧五星", num: 90 }] },
      savedPity: { num5: 89 }, balance: { pink: 2, blue: 1 },
    });
    const set = (scope: string, body: unknown, ttlAt = saved + retention, qq = "42") =>
      admin!.send("SET", [key(scope, qq), JSON.stringify(body), "PXAT", String(ttlAt)]);
    await Promise.all([
      set("50", payload(10, 0)),
      set("51", payload(20, 10)),
      admin.send("SET", [key("52"), JSON.stringify(payload(10, 0))]), // PEXPIRETIME -1.
      set("53", payload(10, 0, expiry + 60)),
      set("54", payload(1, 10)),
      set("56", payload(10, 10)), // Disabled scene, and deliberately excluded from the ACL.
      set("57", payload(10, 10)), // Listed in the manifest but denied by the test ACL.
      set("58", payload(0, 0)),
      set("59", payload(10, 0), capturedAt + retention + 1000),
      set("60", payload(10, 0, expiry - 86_400), start - hour + retention),
      set("61", payload(Number.MAX_SAFE_INTEGER - 1, 10)),
      set("62", payload(10, 0), start + 999 + retention),
      set("private", payload(0, 10)),
      set("private", payload(20, 0), saved + retention, "43"),
    ]);
    const sourceBefore = await Promise.all([admin.get(key("50")), admin.send("PEXPIRETIME", [key("50")])]);
    const auth = join(root, "authorization.json");
    const manifest = (conversations: string[], qq = "42") =>
      writeFile(auth, JSON.stringify({ source: "trss-genshin-0290a17", timeZone: "Asia/Shanghai",
        capturedAt, accounts: [{ qq, conversations }] }));
    await manifest(authScopes);
    const destination = join(root, "destination"), clean = join(root, "dry-run");
    let settings = parseWishSettings({ recallSeconds: 0, dailyDrawLimits: {
      default: { count: 1, separate: false }, 56: null,
    } });
    const signal = new AbortController().signal;
    const options = { sourceUrl, authorizationFile: auth, destinationDirectory: destination, signal,
      now: () => now, readSettings: async () => settings };
    const importLimits = (apply: boolean, directory = destination) =>
      importTrssWishLimits({ ...options, apply, destinationDirectory: directory }, lockFile);
    const run = createWishCommands({ lockFile, signal, storeDirectory: destination, now: () => now, random: () => 0.92,
      poolSource: createWishPoolSource({ themeDirectory: "/unavailable", legacyDirectory: "" }),
      readSettings: async () => settings, render: async () => { throw new Error("此回放核对文字回执和档案"); } });
    const account = (qq = "42") => readFile(join(destination, qq, "1.json"), "utf8").then(JSON.parse);

    const preview = await importLimits(false, clean);
    expect(preview).toEqual({ accounts: 1, carried: 2, existing: 0, conflict: 0, missing: 1,
      empty: 1, expired: 1, invalid: 6, unavailable: 1, inactive: 1 });
    await expect(stat(clean)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(importTrssWishLimits({ ...options, apply: false,
      sourceUrl: "redis://trss-reader:fixture-reader@192.0.2.1:36501/3" }, lockFile)).rejects.toThrow("独立本机");
    await expect(importTrssWishLimits({ ...options, apply: false,
      sourceUrl: `redis://default:fixture-reader@127.0.0.1:${port}/3` }, lockFile)).rejects.toThrow("独立本机");

    expect(await run("#单抽", { user_id: 42, group_id: 51 })).toContain("1抽");
    const native = (await account()).conversations["51"];
    const applied = await Promise.all([importLimits(true), importLimits(true)]);
    expect(applied.map(item => item.carried).sort()).toEqual([0, 1]);
    expect(applied.map(item => item.existing).sort()).toEqual([1, 2]);
    const after = await account();
    expect(after.conversations).toEqual({ 51: native });
    expect(after.trssLimits).toEqual({ 50: { day, normalDraws: 10, weaponDraws: 0 } });
    expect(after.balance).toEqual({ day, pink: 99, blue: 10 });

    const group = { user_id: 42, group_id: 50 };
    expect(await run("#十连", group)).toContain("已达到 10 抽上限");
    const blocked = await account();
    expect(blocked.conversations["50"].today).toMatchObject({ normalDraws: 0, weaponDraws: 0, five: 0, preview: [] });
    expect(blocked.conversations["50"].session.role.num5).toBe(0);
    expect(blocked.balance).toEqual(after.balance);
    expect(await run("#单抽", { user_id: 42, message_type: "private" })).toContain("1抽");
    expect(await run("#单抽", { ...group, isMaster: true, isBotMaster: () => true })).toContain("1抽");

    settings = parseWishSettings({ recallSeconds: 0, dailyDrawLimits: { default: { count: 1, separate: true } } });
    expect(await run("#武器十连", group)).toContain("10抽");
    expect(await run("#武器单抽", group)).toContain("武器池已达到 10 抽上限");
    expect(await run("#常驻单抽", group)).toContain("角色与常驻池已达到 10 抽上限");

    await manifest(["private"], "43");
    expect(await importLimits(true)).toMatchObject({ carried: 1 });
    const beforeFlower = await account("43");
    expect(beforeFlower).toEqual({ balance: { day: 0, pink: 0, blue: 0 }, conversations: {},
      trssLimits: { private: { day, normalDraws: 20, weaponDraws: 0 } } });
    const flower = createLegacyWishImport(destination, lockFile, signal);
    const flowerToday = { day, normalDraws: 2, weaponDraws: 0, five: 0, preview: [] };
    expect(await flower.mergeAccount("43", { conversations: {
      private: { activeDay: day, session: emptySession(wishWeeklyKey(day)), today: flowerToday },
    } }, true)).toEqual({ status: "imported", balance: 0, sessions: 1 });
    expect(await account("43")).toMatchObject({ conversations: { private: { today: flowerToday } }, trssLimits: {} });
    expect(await importLimits(true)).toMatchObject({ carried: 0, existing: 1 });

    const firstSnapshot = await account();
    expect(await Promise.all([admin.get(key("50")), admin.send("PEXPIRETIME", [key("50")])])).toEqual(sourceBefore);
    // A separate, deliberately altered fixture with no modern draws has a conflicting same-day count.
    await manifest(["50"]);
    await set("50", payload(20, 0));
    const conflictDest = join(root, "conflict");
    expect(await importLimits(true, conflictDest)).toMatchObject({ carried: 1 });
    await set("50", payload(30, 0));
    expect(await importLimits(true, conflictDest)).toMatchObject({ carried: 0, conflict: 1 });
    const conflict = JSON.parse(await readFile(join(conflictDest, "42/1.json"), "utf8"));
    expect(conflict.trssLimits["50"].normalDraws).toBe(20);
    expect(await account()).toEqual(firstSnapshot);

    // Midnight produces k=24 in the frozen source, and advertises the next calendar day's 03:59:59.
    now = start + 21 * hour;
    const midnight = start + 20 * hour;
    await set("50", payload(40, 0, expiry + 86_400), midnight + 60_000 + retention);
    await writeFile(auth, JSON.stringify({ source: "trss-genshin-0290a17", timeZone: "Asia/Shanghai",
      capturedAt: now - 30_000, accounts: [{ qq: "42", conversations: ["50"] }] }));
    expect(await importLimits(true, clean)).toMatchObject({ carried: 0, invalid: 1 });
    await expect(stat(clean)).rejects.toMatchObject({ code: "ENOENT" });

    await set("50", payload(10, 0, next / 1000), start + 22 * hour + retention);
    now = start + 23 * hour;
    await writeFile(auth, JSON.stringify({ source: "trss-genshin-0290a17", timeZone: "Asia/Shanghai",
      capturedAt: now - 30_000, accounts: [{ qq: "42", conversations: ["50"] }] }));
    expect(await importLimits(false, clean)).toMatchObject({ carried: 1, invalid: 0 });

    const rollover = join(root, "rollover");
    const duringLock = async (file: string, subject: string) => {
      const held = await lockFile(file, subject);
      now = next;
      return held;
    };
    expect(await importTrssWishLimits({ ...options, apply: true, destinationDirectory: rollover }, duringLock))
      .toMatchObject({ carried: 0, expired: 1 });
    await expect(stat(join(rollover, "42/1.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await importLimits(true)).toMatchObject({ carried: 0, expired: 1 });
    expect(await run("#单抽", group)).toContain("今日成功领取100个纠缠之缘");
    expect(await account()).toMatchObject({ trssLimits: {}, conversations: { 50: { today: {
      day: day + 1, normalDraws: 1, weaponDraws: 0,
    } } } });

    // Invoke the operator command from a distinct, synthetic installation with its own settings.
    const installation = join(root, "installation");
    const moduleDirectory = join(installation, "plugins/genshin/wish-sim");
    await mkdir(moduleDirectory, { recursive: true });
    await cp(new URL("../plugins/genshin/wish-sim/", import.meta.url), moduleDirectory, { recursive: true });
    await cp(new URL("../plugins/genshin/wish-calendar.ts", import.meta.url), join(moduleDirectory, "../wish-calendar.ts"));
    for (const directory of ["lib", "node_modules"]) {
      await symlink(fileURLToPath(new URL("../" + directory, import.meta.url)), join(installation, directory), "dir");
    }
    await mkdir(join(installation, "config"));
    const localConfiguration = join(installation, "config/genshin-wish.yaml");
    await writeFile(localConfiguration, JSON.stringify(settings));

    let realNow = Date.now();
    const toReset = wishDayStart(wishDailyKey(realNow) + 1) - realNow;
    if (toReset < 1500) await Bun.sleep(toReset + 1100);
    else if (realNow - wishDayStart(wishDailyKey(realNow)) < 1500) await Bun.sleep(1600);
    realNow = Date.now();
    const realDay = wishDailyKey(realNow);
    const realStart = wishDayStart(realDay), realMidnight = realStart + 20 * hour;
    let realSaved = realNow - 250;
    if (realSaved >= realMidnight && realSaved < realMidnight + hour) realSaved = realMidnight - 1000;
    const realExpiry = (realStart + wishDayMs) / 1000 - Number(realSaved < realMidnight + hour);
    await set("50", payload(10, 0, realExpiry), realSaved + retention);
    await writeFile(auth, JSON.stringify({ source: "trss-genshin-0290a17", timeZone: "Asia/Shanghai",
      capturedAt: realNow, accounts: [{ qq: "42", conversations: ["50"] }] }));
    const cliDestination = join(installation, "data/genshin/wish-sim");
    const cli = (apply: boolean) => Bun.spawn([process.execPath, join(moduleDirectory, "import-legacy-cli.ts"), "--trss-daily",
      ...(apply ? ["--apply"] : []), auth, cliDestination], {
      cwd: installation, env: { LOTUS_GENSHIN_TRSS_WISH_SNAPSHOT_URL: sourceUrl }, stdout: "pipe", stderr: "pipe",
    });
    for (const apply of [false, true]) {
      const command = cli(apply);
      const [output, error, status] = await Promise.all([
        new Response(command.stdout).text(), new Response(command.stderr).text(), command.exited,
      ]);
      expect(status, error).toBe(0);
      expect(JSON.parse(output)).toMatchObject({ mode: apply ? "apply" : "preview", source: "trss", carried: 1 });
      expect(output).not.toContain("fixture-reader");
      if (!apply) await expect(stat(cliDestination)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const cliSaved = JSON.parse(await readFile(join(cliDestination, "42/1.json"), "utf8"));
    expect(cliSaved.trssLimits).toEqual({ 50: { day: realDay, normalDraws: 10, weaponDraws: 0 } });
  } finally {
    admin?.close();
    server.kill();
    await server.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 8_000);
