import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createProfileStore, MAX_PROFILE_ID, profileCookieAccountId, type Game, type ProfileRequestContext } from "@lotus-yunzai/account";
import { createProfileHoyoClient, type DailyNoteSnapshot } from "@lotus-yunzai/hoyo-client";
import { notifyCheckin, type BotNotifications } from "./checkin-notify.ts";
import type { CommandModule } from "./commands.ts";

export const dailyNoteReminderFeatureNames = ["体力推送", "@lotus-yunzai/daily-note-reminders"] as const;

const gameNames = { gs: "原神", sr: "星铁", zzz: "绝区零" } as const;
const resources = { gs: "树脂", sr: "开拓力", zzz: "电量" } as const;
const defaults = { gs: 160, sr: 260, zzz: 200 } as const;
const minimum = { gs: 100, sr: 150, zzz: 120 } as const;
const gameBusiness = { gs: "hk4e_cn", sr: "hkrpg_cn", zzz: "nap_cn" } as const;
const pollInterval = 30 * 60_000;
const hour = 60 * 60_000;
const defaultCooldown = 12 * hour;

export function dailyNoteReminderCooldown(hours: unknown) {
  const value = typeof hours === "string" && /^\d+(?:\.\d+)?$/u.test(hours) ? Number(hours) : hours;
  const seconds = typeof value === "number" ? value * 3600 : 0;
  const milliseconds = seconds * 1000;
  return seconds > 0 && Number.isSafeInteger(seconds) && Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}
const enrollment = /^#?(原神|星铁|绝区零)?(开启|关闭)体力推送(?:\s*([1-9]\d{7,9}))?(?:\s+档案\s*([1-9]\d{0,2}))?$/u;
const threshold = /^#?(原神|星铁|绝区零)?体力推送(?:阈值)?\s*([1-9]\d{0,2})$/u;

type Destination = { readonly bot: number; readonly group_id: number; readonly qq: number };
type Key = Destination & { readonly game: Game };
type Target = DailyNoteReminderEnrollment & { readonly nextAt: number };
export type DailyNoteReminderEnrollment = Key & {
  readonly uid: string; readonly profile: number; readonly binding: string; readonly threshold: number; readonly legacyUntil: number;
};
type ReadNote = { readonly snapshot: DailyNoteSnapshot; readonly revision: string };

function gameOf(name?: string): Game {
  return name === "星铁" ? "sr" : name === "绝区零" ? "zzz" : "gs";
}

export function dailyNoteReminderBinding(source: ProfileRequestContext) {
  const { account, qq, profileId, game, role } = source;
  const id = profileCookieAccountId(account);
  const channel = role.uid.startsWith("5");
  const validRole = game === "zzz"
    ? /^[1-9]\d{7,8}$/u.test(role.uid) && /^prod_(?:gf|qd)_cn$/u.test(role.region)
    : /^[1-5]\d{8}$/u.test(role.uid) && role.region === (game === "gs"
      ? (channel ? "cn_qd01" : "cn_gf01") : (channel ? "prod_qd_cn" : "prod_gf_cn"));
  if (id && validRole && role.gameBiz === gameBusiness[game]) {
    return createHash("sha256").update(JSON.stringify([qq, profileId, id, game, role.uid, role.region, role.gameBiz])).digest("hex");
  }
}

function databaseFile(file: string, create: boolean) {
  try {
    const info = lstatSync(file);
    if (!info.isFile()) throw new Error("体力推送存档须为普通文件。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  }
  const database = new Database(file, { strict: true, create });
  try {
    chmodSync(file, 0o600);
    database.exec("PRAGMA busy_timeout = 1000");
    database.transaction(() => {
      database.exec(`
      CREATE TABLE IF NOT EXISTS daily_note_reminders (
        bot INTEGER NOT NULL, group_id INTEGER NOT NULL, qq INTEGER NOT NULL, game TEXT NOT NULL, uid TEXT NOT NULL,
        profile INTEGER NOT NULL, binding TEXT NOT NULL, threshold INTEGER NOT NULL, nextAt INTEGER NOT NULL DEFAULT 0,
        legacyUntil INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bot, group_id, qq, game, uid)
      );`);
      if (!database.query<{ name: string }, []>("PRAGMA table_info(daily_note_reminders)").all().some(row => row.name === "legacyUntil")) {
        database.exec("ALTER TABLE daily_note_reminders ADD COLUMN legacyUntil INTEGER NOT NULL DEFAULT 0");
      }
    }).immediate();
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function groupKey({ bot, group_id, qq, game }: Key) {
  return { $bot: bot, $group: group_id, $qq: qq, $game: game };
}

const actorSql = "bot=$bot AND group_id=$group AND qq=$qq AND game=$game";
const targetSql = `${actorSql} AND uid=$uid`;

export function writeMigratedDailyNoteReminders(file: string, rows: readonly DailyNoteReminderEnrollment[]) {
  const database = databaseFile(file, false);
  if (!database) throw new Error("体力推送暂存数据库须先创建。");
  try {
    database.transaction(() => {
      const insert = database.query(`INSERT INTO daily_note_reminders (bot,group_id,qq,game,uid,profile,binding,threshold,legacyUntil)
        VALUES ($bot,$group,$qq,$game,$uid,$profile,$binding,$threshold,$legacyUntil)`);
      for (const row of rows) insert.run({ ...groupKey(row), $uid: row.uid, $profile: row.profile, $binding: row.binding,
        $threshold: row.threshold, $legacyUntil: row.legacyUntil });
    }).immediate();
  } finally { database.close(); }
}

export function createDailyNoteReminders({
  directory, file, signal, enabled, cooldownHours, activeSignal, allowed, transports, transport, legacyTimeToLive, now = Date.now,
}: {
  readonly directory?: string;
  readonly file: string;
  readonly signal: AbortSignal;
  readonly enabled: boolean;
  readonly cooldownHours?: unknown;
  readonly activeSignal: () => AbortSignal;
  readonly allowed: (target: Destination) => boolean;
  readonly transports: () => readonly BotNotifications[];
  readonly transport?: Parameters<typeof createProfileHoyoClient>[1];
  readonly legacyTimeToLive?: (key: string) => Promise<number | undefined>;
  readonly now?: () => number;
}) {
  const cooldown = dailyNoteReminderCooldown(cooldownHours) ?? defaultCooldown;
  const profiles = createProfileStore(directory);
  const client = createProfileHoyoClient(profiles, transport);
  let database: Database | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  const active = (current: AbortSignal) => enabled && !stopped && !signal.aborted && !current.aborted;
  function open(create: boolean) {
    return database ??= databaseFile(file, create);
  }

  async function sourceFor(target: Target) {
    const source = await profiles.requestContext(String(target.qq), target.profile, target.game, target.uid).catch(() => undefined);
    return source && dailyNoteReminderBinding(source) === target.binding ? source : undefined;
  }

  async function readNote(target: Target, current: AbortSignal): Promise<ReadNote | undefined> {
    const source = await sourceFor(target);
    if (!source || !active(current)) return;
    const [result] = await client.fetchDailyNotes([source], { signal: current });
    if (!result || result.status !== "fulfilled") return;
    const snapshot = result.value;
    if (snapshot.uid !== target.uid || snapshot.game !== target.game) return;
    const latest = await sourceFor(target);
    if (latest && active(current)) return { snapshot, revision: latest.revision };
  }

  async function legacyCooldown(key: string, current: AbortSignal) {
    if (!legacyTimeToLive) return;
    const pending = new AbortController();
    try {
      return await Promise.race([legacyTimeToLive(key), delay(1_500, undefined, {
        signal: AbortSignal.any([pending.signal, current]), ref: false,
      })]);
    } catch {
      return undefined;
    } finally { pending.abort(); }
  }

  async function scan() {
    const current = activeSignal();
    if (!active(current)) return;
    const db = open(false);
    if (!db) return;
    const due = db.query<Target, [number]>(
      "SELECT * FROM daily_note_reminders WHERE nextAt <= ? ORDER BY bot,group_id,qq,game,uid").all(now());
    const readings = new Map<string, ReadNote | undefined>();
    for (const target of due) {
      if (!active(current)) return;
      if (!allowed(target)) continue;
      const gateway = transports().find(item => item.botId === target.bot);
      if (!gateway || !await gateway.isGroupMember(target.group_id, target.qq).catch(() => false) || !active(current)) continue;
      if (target.legacyUntil > 0) {
        const legacyKey = `${target.group_id}:${target.bot}:${target.game}_NoteTask:${target.uid}`;
        const ttl = await legacyCooldown(legacyKey, current);
        if (!active(current)) return;
        if (typeof ttl === "number" && Number.isSafeInteger(ttl) && ttl > 0) {
          const at = now();
          const until = Math.min(Number.MAX_SAFE_INTEGER, at + ttl);
          db.query(`UPDATE daily_note_reminders SET nextAt=$until WHERE ${targetSql}
            AND binding=$binding AND legacyUntil=$legacyUntil AND nextAt <= $at`)
            .run({ ...groupKey(target), $uid: target.uid, $binding: target.binding, $legacyUntil: target.legacyUntil, $at: at, $until: until });
          continue;
        }
        if (ttl === -1 || (ttl !== -2 && ttl !== 0 && now() < target.legacyUntil)) continue;
      }
      const key = target.binding;
      if (!readings.has(key)) readings.set(key, await readNote(target, current).catch(() => undefined));
      const note = readings.get(key);
      if (!note || note.snapshot.stamina.current < target.threshold || !active(current)) continue;
      const { current: points, max } = note.snapshot.stamina;
      const sql = { ...groupKey(target), $uid: target.uid, $binding: target.binding, $threshold: target.threshold };
      let claimed: number | undefined;
      const result = await notifyCheckin({
        userId: target.qq, transports: [gateway], signal: current,
        settings: { enabled: true, prefer: "group", fallbackGroups: [target.group_id] },
        reply: `${gameNames[target.game]}${resources[target.game]}已达到提醒阈值（${points}/${max}）。`,
        async verifySend() {
          const latest = await sourceFor(target);
          if (latest?.revision !== note.revision || !active(current) || !allowed(target)) return false;
          const at = now();
          const until = Math.min(Number.MAX_SAFE_INTEGER, at + cooldown);
          if (db.query(`UPDATE daily_note_reminders SET nextAt=$until WHERE ${targetSql}
              AND binding=$binding AND threshold=$threshold AND nextAt <= $at`)
            .run({ ...sql, $at: at, $until: until }).changes !== 1) return false;
          claimed = until;
          return true;
        },
      });
      if (claimed !== undefined && (result.status === "unavailable" || result.status === "skipped")) {
        db.query(`UPDATE daily_note_reminders SET nextAt=0 WHERE ${targetSql}
          AND binding=$binding AND threshold=$threshold AND nextAt=$until`).run({ ...sql, $until: claimed });
      } else if (claimed !== undefined) {
        db.query(`UPDATE daily_note_reminders SET legacyUntil=0 WHERE ${targetSql}
          AND binding=$binding AND threshold=$threshold AND nextAt=$until`).run({ ...sql, $until: claimed });
      }
    }
  }

  function runDue() {
    if (!enabled || stopped) return;
    return running ??= scan().finally(() => { running = undefined; });
  }

  const commands: CommandModule = {
    name: "@lotus-yunzai/daily-note-reminders", commands: {},
    fallbackFeatures: () => dailyNoteReminderFeatureNames,
    async fallback(_message, event) {
      const action = enrollment.exec(event.normalizedMessage);
      const level = action ? null : threshold.exec(event.normalizedMessage);
      if (!action && !level) return;
      const { isDelegated, message_type, self_id: bot, group_id, user_id: qq } = event;
      const validId = (id?: number): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0;
      if (isDelegated || message_type !== "group" || !validId(bot) || !validId(group_id) || !validId(qq) || bot === qq) {
        return "请在本人要接收体力提醒的群里使用此指令。";
      }
      if (!enabled) return "本机器人未开启体力推送。";
      const current = activeSignal();
      const destination = { bot, group_id, qq };
      const gateway = transports().find(item => item.botId === bot);
      const eligible = () => active(current) && allowed(destination);
      if (!eligible() || !gateway || !await gateway.isGroupMember(group_id, qq).catch(() => false) || !eligible()) return;
      const game = gameOf((action ?? level)?.[1]);
      const label = `${gameNames[game]}体力推送`;
      const key = groupKey({ ...destination, game });
      const profile = action?.[4] ? Number(action[4]) : undefined;
      if (profile && profile > MAX_PROFILE_ID) return "档案编号须在 1 到 255 之间。";
      const uid = action?.[3];
      try {
        if (level) {
          const value = Number(level[2]);
          if (value < minimum[game]) return `${label}阈值不能小于 ${minimum[game]}。`;
          const changed = open(false)?.query(`UPDATE daily_note_reminders SET threshold=$threshold WHERE ${actorSql}`)
            .run({ ...key, $threshold: value }).changes;
          return changed ? `${label}阈值已设为 ${value}。` : `你还没有在本群开启${label}。`;
        }
        if (action?.[2] === "关闭") {
          const changed = open(false)?.query(`DELETE FROM daily_note_reminders WHERE ${actorSql}
            AND ($uid IS NULL OR uid=$uid) AND ($profile IS NULL OR profile=$profile)`)
            .run({ ...key, $uid: uid ?? null, $profile: profile ?? null }).changes;
          return changed ? `本群${label}已关闭。` : `你还没有在本群开启${label}。`;
        }
        const user = String(qq);
        const selectable = new Map<string, { source: ProfileRequestContext; binding: string }>();
        for (const id of profile ? [profile] : await profiles.listIds(user)) {
          const roles = await profiles.requestContexts(user, id, [game]).catch(() => []);
          for (const source of roles) {
            if (uid && source.role.uid !== uid) continue;
            const binding = dailyNoteReminderBinding(source);
            if (!binding) continue;
            if (selectable.has(source.role.uid)) return "同一 UID 出现在多个登录档案，请在指令末尾加上 档案编号。";
            selectable.set(source.role.uid, { source, binding });
          }
        }
        if (!selectable.size) return "请先扫码登录并同步本人角色。";
        for (const [roleUid, { source, binding }] of selectable) {
          const fresh = await sourceFor({ ...destination, game, uid: roleUid, profile: source.profileId, binding,
            threshold: defaults[game], nextAt: 0, legacyUntil: 0 });
          if (fresh?.revision !== source.revision || !eligible()) return "档案已变化，请重新设置体力推送。";
        }
        const db = open(true)!;
        const value = db.transaction(() => {
          const row = db.query<{ threshold: number }, typeof key>(`SELECT threshold FROM daily_note_reminders WHERE ${actorSql} LIMIT 1`).get(key);
          const selected = row?.threshold ?? defaults[game];
          const save = db.query(`INSERT INTO daily_note_reminders (bot,group_id,qq,game,uid,profile,binding,threshold)
            VALUES ($bot,$group,$qq,$game,$uid,$profile,$binding,$threshold)
            ON CONFLICT(bot,group_id,qq,game,uid) DO UPDATE SET profile=excluded.profile,binding=excluded.binding`);
          for (const [roleUid, { source, binding }] of selectable) {
            save.run({ ...key, $uid: roleUid, $profile: source.profileId, $binding: binding, $threshold: selected });
          }
          return selected;
        }).immediate();
        return `本群${label}已开启，${selectable.size} 个角色，阈值 ${value}。`;
      } catch {
        return "暂时无法保存体力推送设置，请稍后再试。";
      }
    },
  };

  return {
    commands, runDue,
    start() {
      if (!enabled || stopped || timer) return;
      timer = setInterval(() => { void runDue()?.catch(() => console.warn("[体力推送] 无法读取本轮设置。")); }, pollInterval);
      timer.unref();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running?.catch(() => {});
      database?.close();
      database = undefined;
    },
  };
}
