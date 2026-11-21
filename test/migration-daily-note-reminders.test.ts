import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { scheduledJobs } from "node-schedule";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeStorage, connectStorage } from "@lotus-yunzai/storage";
import { encodeMilkyReply } from "../lib/adapters/milky-message.ts";
import { encodeOneBotReply } from "../lib/adapters/onebot-message.ts";
import { createDailyNoteReminders } from "../lib/daily-note-reminders.ts";
import { stageLegacyDailyNoteReminders } from "../lib/migration-daily-note-reminders.ts";
import { stageLegacyGlobalConfig } from "../lib/migration-global-config.ts";
import { stageLegacyProfiles } from "../lib/migration-profiles.ts";
import { migrateInstallation } from "../scripts/migrate.ts";
import type { MessageReply } from "../lib/messages.ts";

const valkey = Bun.which("valkey-server");
const oldConfig = "plugins/bujidao/config";
const gs = { uid: "100012345", region: "cn_gf01", game_biz: "hk4e_cn" };
const sr = { uid: "500012345", region: "prod_qd_cn", game_biz: "hkrpg_cn" };
const zzz = { uid: "12001234", region: "prod_gf_cn", game_biz: "nap_cn" };
const path = "data/daily-note/reminders.sqlite";
const hour = 3_600_000;
const oldMessage = "[CQ:at,qq=all] #重启 @全体成员";
const oldCron = "0 1 8 * * ?";

async function put(root: string, local: string, text: string) {
  const file = join(root, local);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

function profile(qq: string, number: number, roles: object, account = "351") {
  return Bun.YAML.stringify({ user: { qq }, profile: { id: number },
    account: { stuid: account, ltuid: account, cookie: `account_id=${account};cookie_token=fixture`, stoken: "fixture",
      game_roles: roles },
  });
}

function stagedRows(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    return db.query<{ uid: string; nextAt: number; legacyUntil: number }, []>(
      "SELECT uid,nextAt,legacyUntil FROM daily_note_reminders ORDER BY uid").all();
  } finally { db.close(); }
}

test.skipIf(!valkey || !Bun.which("git"))("一体化旧提醒登记承接 Valkey 原键 TTL，官方读取与通知按本人和原群恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-reminder-migrate-"));
  const source = join(root, "old");
  const target = join(root, "target");
  const control = new AbortController();
  let runtime: ReturnType<typeof createDailyNoteReminders> | undefined;
  let stopValkey: (() => Promise<void>) | undefined;
  try {
    await mkdir(target);
    expect(Bun.spawnSync(["git", "init", "--quiet"], { cwd: target }).exitCode).toBe(0);
    await put(target, "plugins/.fixture", "测试迁移目标");
    await put(target, "package.json", '{"name":"lotus-yunzai"}');
    expect(Bun.spawnSync(["git", "add", "plugins/.fixture", "package.json"], { cwd: target }).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: target }).exitCode).toBe(0);
    const fixture = Bun.YAML.stringify({
      "99": {
        "42": { "77": { gs: [Number(gs.uid), gs.uid], gs_Resin: 175, sr: [sr.uid], sr_Resin: 270, zzz: [zzz.uid], zzz_Resin: "202" } },
        "43": { "77": { gs: [gs.uid], gs_Resin: 190 } },
        "44": { "77": { gs: [gs.uid], gs_Resin: 190 } },
        "45": { "78": { zzz: [zzz.uid], zzz_Resin: 0 } },
      },
    });
    await put(source, `${oldConfig}/defnote.yaml`, fixture);
    await put(source, `${oldConfig}/config.yaml`, Bun.YAML.stringify({
      Note: false, NoteTask: true, sendCD: 2, TaskTime: oldCron + " 2099", TaskMsg: oldMessage,
    }));
    await put(source, "plugins/Lotus-Plugin/data/users/42-2.yaml", profile("42", 2, { gs: [gs], sr: [sr], zzz: [zzz] }));
    await put(source, "plugins/Lotus-Plugin/data/users/44.yaml", profile("44", 1, { gs: [gs] }, "352"));
    await put(source, "plugins/Lotus-Plugin/data/users/44-2.yaml", profile("44", 2, { gs: [gs] }, "352"));
    const migrated = await migrateInstallation(source, target);
    const file = join(target, path);
    const report = { files: 2, enrolled: 3, invalid: 1, unverified: 1, ambiguous: 1, duplicates: 1, enabled: true, cooldownHours: 2, invalidCron: false, invalidMessage: false };
    expect(JSON.stringify(migrated)).not.toContain(oldMessage);
    expect(migrated).toMatchObject({ status: "published", dailyNoteReminders: report });
    expect(await migrateInstallation(source, target)).toMatchObject({ status: "already-published", dailyNoteReminders: report });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const applied = Bun.YAML.parse(await readFile(join(target, "config/global.yaml"), "utf8")) as {
      daily_note_reminders: { enable: boolean; cooldown_hours: number; cron: string; message: string };
    };
    expect(applied.daily_note_reminders).toEqual({ enable: true, cooldown_hours: 2, cron: oldCron, message: oldMessage });

    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const { port } = listener;
    listener.stop(true);
    const password = crypto.randomUUID();
    const process = Bun.spawn([valkey!, "--bind", "127.0.0.1", "--port", String(port), "--requirepass", password,
      "--save", "", "--appendonly", "no", "--dir", root], { stdout: "pipe", stderr: "ignore" });
    stopValkey = async () => {
      process.kill();
      await process.exited;
    };
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    let started = "";
    while (!started.includes("Ready to accept connections")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("测试 Valkey 未启动。");
      started += decoder.decode(chunk.value, { stream: true });
    }
    reader.releaseLock();
    const redis = await connectStorage(`redis://:${password}@127.0.0.1:${port}/4`);
    const oldGenshin = `77:99:gs_NoteTask:${gs.uid}`;
    const oldStarRail = `77:99:sr_NoteTask:${sr.uid}`;
    await redis.set(oldGenshin, "1", { PX: 90_000 });
    await redis.set(oldStarRail, "1");
    await redis.set(`78:99:zzz_NoteTask:${zzz.uid}`, "1");
    const reads: string[] = [];
    const notifications: MessageReply[] = [];
    const ttlKeys: string[] = [];
    let onlineStorage = true;
    let at = Math.max(Date.now(), ...stagedRows(file).map(row => row.legacyUntil - 2 * hour + 1000));
    runtime = createDailyNoteReminders({
      directory: join(target, "data/users"), file, enabled: applied.daily_note_reminders.enable, signal: control.signal,
      cooldownHours: applied.daily_note_reminders.cooldown_hours,
      cron: applied.daily_note_reminders.cron, message: applied.daily_note_reminders.message,
      activeSignal: () => control.signal, allowed: row => row.bot === 99 && row.group_id === 77 && row.qq === 42, now: () => at,
      async legacyTimeToLive(key) {
        ttlKeys.push(key);
        if (onlineStorage) return redis.pTTL(key);
      },
      transports: () => [{ botId: 99, async isFriend() { throw new Error("旧登记只走原群"); },
        async sendPrivate() { throw new Error("旧登记只走原群"); },
        async isGroupMember(gid, qq) { return gid === 77 && qq === 42; },
        async sendGroup(gid, reply) { expect(gid).toBe(77); notifications.push(reply); return "confirmed"; } }],
      async transport(url, options) {
        expect(url.origin).toBe("https://api-takumi-record.mihoyo.com");
        expect(new Headers(options.headers).get("Cookie")).toContain("account_id=351");
        const uid = url.searchParams.get("role_id")!;
        reads.push(uid);
        const stamina = uid === gs.uid ? { current_resin: 190, max_resin: 200 }
          : uid === sr.uid ? { current_stamina: 290, max_stamina: 300 } : { energy: { progress: { current: 231, max: 240 } } };
        return Response.json({ retcode: 0, data: { role_id: uid, server: url.searchParams.get("server"), ...stamina } });
      },
    });
    const before = new Set(Object.keys(scheduledJobs));
    runtime.start();
    runtime.start();
    const jobs = Object.entries(scheduledJobs).filter(([key]) => !before.has(key)).map(([, candidate]) => candidate);
    expect(jobs).toHaveLength(1);
    const next = jobs[0]!.nextInvocation();
    if (!next) throw new Error("体力推送没有预期的下一次运行。");
    expect(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }).format(next.getTime()))
      .toBe("08:01");
    await runtime.runDue();
    expect(reads).toEqual([zzz.uid]);
    expect(notifications).toHaveLength(1);
    expect(await redis.get(oldGenshin)).toBe("1");
    const held = stagedRows(file).find(row => row.uid === gs.uid)!;
    expect(held.nextAt).toBeGreaterThan(at);
    expect(held.nextAt).toBeLessThanOrEqual(at + 90_000);
    expect(stagedRows(file).find(row => row.uid === zzz.uid)).toMatchObject({ legacyUntil: 0, nextAt: at + 2 * hour });

    at = held.nextAt + 1;
    await redis.del(oldGenshin);
    onlineStorage = false;
    await runtime.runDue();
    expect(notifications).toHaveLength(1);
    onlineStorage = true;
    await runtime.runDue();
    expect(reads).toEqual([zzz.uid, gs.uid]);
    expect(notifications).toHaveLength(2);

    await redis.del(oldStarRail);
    onlineStorage = false;
    at = held.legacyUntil + 1;
    await runtime.runDue();
    expect(reads).toEqual([zzz.uid, gs.uid, sr.uid]);
    expect(notifications).toHaveLength(3);
    for (const [index, title] of ["绝区零电量", "原神树脂", "星铁开拓力"].entries()) {
      const reply = notifications[index]!;
      const onebot = encodeOneBotReply(reply);
      const milky = encodeMilkyReply(reply);
      expect(Array.isArray(onebot) && onebot.filter(part => part.type === "at")).toEqual([{ type: "at", data: { qq: "42" } }]);
      expect(milky?.filter(part => part.type === "mention" || part.type === "mention_all"))
        .toEqual([{ type: "mention", data: { user_id: 42 } }]);
      expect(Array.isArray(onebot) && onebot.at(-1)).toMatchObject({ type: "text", data: { text: expect.stringContaining(oldMessage + "\n" + title) } });
      expect(milky?.at(-1)).toMatchObject({ type: "text", data: { text: expect.stringContaining(oldMessage + "\n" + title) } });
    }
    expect(ttlKeys.some(key => key.startsWith("78:"))).toBe(false);
    expect(await readFile(join(source, oldConfig, "defnote.yaml"), "utf8")).toBe(fixture);
  } finally {
    control.abort();
    await runtime?.stop();
    await closeStorage();
    await stopValkey?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("只移植证据明确的登记文件，显式全局关闭不被旧任务开关覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-reminder-migrate-config-"));
  const source = join(root, "old");
  const stage = join(root, "stage");
  try {
    await mkdir(stage);
    const legacyPath = `${oldConfig}/defnote.yaml`;
    const yaml = Bun.YAML.stringify({ 99: { 42: { 77: { gs: [gs.uid], gs_Resin: 180 } } } });
    await put(source, legacyPath, yaml);
    await put(source, `${oldConfig}/config.yaml`, "NoteTask: true\n");
    await put(source, "config/config/global.yaml", Bun.YAML.stringify({
      daily_note_reminders: { enable: false, cron: "0 2 9 * * *", message: "新版通知文字" },
    }));
    await put(source, "plugins/Lotus-Plugin/data/users/42.yaml", profile("42", 1, { gs: [gs] }));
    await stageLegacyProfiles(source, stage);
    const result = await stageLegacyDailyNoteReminders(source, stage);
    expect(result.counts).toMatchObject({ enrolled: 1, enabled: true });
    expect(result.settings).toMatchObject({ cron: "0 0/30 * * * ?", message: "哥哥（姐姐）你的体力快满了哦~" });
    await stageLegacyGlobalConfig(source, stage, undefined, result.settings);
    expect(Bun.YAML.parse(await readFile(join(stage, "config/global.yaml"), "utf8")))
      .toEqual({ daily_note_reminders: { enable: false, cron: "0 2 9 * * *", message: "新版通知文字" } });
    await expect(stageLegacyDailyNoteReminders(source, stage)).rejects.toMatchObject({ code: "EEXIST" });
    await rm(join(source, legacyPath));
    await symlink(join(stage, "config/global.yaml"), join(source, legacyPath));
    await expect(stageLegacyDailyNoteReminders(source, stage)).rejects.toMatchObject({ reason: "unsafe" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("旧版新版宿主数据库原地补列并保留既有提醒冷却", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-reminder-old-db-"));
  const file = join(root, "reminders.sqlite");
  const at = Date.now();
  const db = new Database(file);
  try {
    db.exec(`CREATE TABLE daily_note_reminders (
      bot INTEGER NOT NULL, group_id INTEGER NOT NULL, qq INTEGER NOT NULL, game TEXT NOT NULL, uid TEXT NOT NULL,
      profile INTEGER NOT NULL, binding TEXT NOT NULL, threshold INTEGER NOT NULL, nextAt INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bot, group_id, qq, game, uid)
    );`);
    db.query("INSERT INTO daily_note_reminders VALUES (99,77,42,'gs',?,1,'fixture',160,?)").run(gs.uid, at + hour);
  } finally { db.close(); }
  const control = new AbortController();
  const runtime = createDailyNoteReminders({
    file, enabled: true, signal: control.signal, activeSignal: () => control.signal,
    allowed: () => { throw new Error("既有冷却未结束"); }, transports: () => [], now: () => at,
  });
  try {
    await runtime.runDue();
    await runtime.runDue();
    expect(stagedRows(file)).toEqual([{ uid: gs.uid, nextAt: at + hour, legacyUntil: 0 }]);
  } finally {
    control.abort();
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("实际 cron 唤醒已有群登记，无效旧配置不会排入调度", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-reminder-cron-"));
  const source = join(root, "old");
  const stage = join(root, "stage");
  const control = new AbortController();
  const timers = new Set(Object.keys(scheduledJobs));
  const file = join(stage, path);
  let runtime: ReturnType<typeof createDailyNoteReminders> | undefined;
  try {
    await mkdir(stage);
    await put(source, oldConfig + "/config.yaml", "NoteTask: true\nTaskTime: '0 0 31 * * ?'\nTaskMsg: {type: 'at', qq: all}\n");
    const invalid = await stageLegacyDailyNoteReminders(source, stage);
    expect(invalid.counts).toMatchObject({ invalidCron: true, invalidMessage: true });
    await stageLegacyGlobalConfig(source, stage, undefined, invalid.settings);
    const invalidConfig = Bun.YAML.parse(await readFile(join(stage, "config/global.yaml"), "utf8"));
    expect(invalidConfig).toEqual({ daily_note_reminders: { enable: true, cron: null } });
    const blocked = createDailyNoteReminders({ file, signal: control.signal, enabled: true,
      cron: null, activeSignal: () => control.signal, allowed: () => true, transports: () => [] });
    try {
      blocked.start();
      expect(Object.keys(scheduledJobs).filter(key => !timers.has(key))).toEqual([]);
    } finally { await blocked.stop(); }

    await put(source, oldConfig + "/config.yaml", "NoteTask: true\nTaskTime: '* * * * * *'\nTaskMsg: ''\n");
    await put(source, oldConfig + "/defnote.yaml", Bun.YAML.stringify({ 99: { 42: { 77: { gs: [gs.uid], gs_Resin: 180 } } } }));
    await put(source, "plugins/Lotus-Plugin/data/users/42.yaml", profile("42", 1, { gs: [gs] }));
    await stageLegacyProfiles(source, stage);
    const migrated = await stageLegacyDailyNoteReminders(source, stage);
    expect(migrated.settings).toMatchObject({ cron: "* * * * * *", message: "" });
    const receipt = Promise.withResolvers<MessageReply>();
    runtime = createDailyNoteReminders({
      file, directory: join(stage, "data/users"), signal: control.signal, enabled: true,
      cron: migrated.settings!.cron, message: migrated.settings!.message,
      activeSignal: () => control.signal, allowed: row => row.bot === 99 && row.group_id === 77 && row.qq === 42,
      legacyTimeToLive: async () => -2,
      transports: () => [{ botId: 99, async isFriend() { return false; }, async sendPrivate() { return "rejected"; },
        async isGroupMember(gid, qq) { return gid === 77 && qq === 42; },
        async sendGroup(gid, reply) { expect(gid).toBe(77); receipt.resolve(reply); return "confirmed"; },
      }],
      async transport(url, options) {
        expect(url.searchParams.get("role_id")).toBe(gs.uid);
        expect(new Headers(options.headers).get("Cookie")).toContain("account_id=351");
        return Response.json({ retcode: 0, data: { role_id: gs.uid, server: gs.region, current_resin: 190, max_resin: 200 } });
      },
    });
    runtime.start();
    const reply = await Promise.race([receipt.promise, Bun.sleep(3500).then(() => undefined)]);
    expect(reply).toEqual([{ type: "at", qq: 42 }, "\n", { type: "text", text: "原神树脂已达到提醒阈值（190/200）。" }]);
    await runtime.stop();
    expect(Object.keys(scheduledJobs).filter(key => !timers.has(key))).toEqual([]);
  } finally {
    control.abort();
    await runtime?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
