import { withCaptchaInteraction } from "../packages/hoyo-client/captcha.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { Database } from "bun:sqlite";
import { Job } from "node-schedule";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createProfileStore, MAX_PROFILE_ID, profileCookieAccountId, type Game, type ProfileRequestContext } from "@lotus-yunzai/account";
import { createProfileHoyoClient, type DailyNoteSnapshot } from "@lotus-yunzai/hoyo-client";
import { notifyCheckin, type BotNotifications } from "./checkin-notify.ts";
import type { CommandModule } from "./commands.ts";
import { segment } from "./messages.ts";
import { legacyHostCronTimeZone } from "./plugins/tasks.ts";

export const dailyNoteReminderFeatureNames = ["体力推送", "@lotus-yunzai/daily-note-reminders"] as const;

const gameNames = { gs: $t("lib.daily-note-reminders.text_d1597c51ed"), sr: $t("lib.daily-note-reminders.text_a2927891f0"), zzz: $t("lib.daily-note-reminders.text_b1110352c9") } as const;
const resources = { gs: $t("lib.daily-note-reminders.text_098c865928"), sr: $t("lib.daily-note-reminders.text_de78a76579"), zzz: $t("lib.daily-note-reminders.text_1c69b1aa72") } as const;
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
function reminderJob(rule: unknown, run: () => Promise<void> | undefined) {
  if (typeof rule !== "string" || rule.length > 160) return;
  const fields = rule.trim().split(/\s+/u);
  if (fields.length === 5) fields.unshift("0");
  if (fields.length !== 6 || !fields.slice(0, 3).every(field => /^[0-9*,/?-]+$/u.test(field)) ||
      !fields.slice(3).every(field => /^[0-9A-Za-z*,/?#-]+$/u.test(field))) return;
  const job = new Job(run);
  try { if (job.schedule({ rule: fields.join(" "), tz: legacyHostCronTimeZone })) return job; }
  catch {}
  job.cancel();
}

export function dailyNoteReminderCron(rule: unknown) {
  const job = reminderJob(rule, () => undefined);
  if (!job) return false;
  job.cancel();
  return true;
}

export function dailyNoteReminderMessage(value: unknown) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 512 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) return;
  return value.replace(/\r\n?/gu, "\n");
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
type PendingNote = { readonly target: Target; readonly note: ReadNote; readonly image?: Buffer };
type ReminderImage = (data: { game: Game; current: number; max: number },
  options: { inlineImageByteLimit?: number; signal: AbortSignal }) => Promise<Buffer | undefined>;

function noticeDescription({ snapshot: { game, stamina: { current, max } } }: ReadNote) {
  return $t("lib.daily-note-reminders.text_f9789a0217", { "value1": gameNames[game], "value2": resources[game], "current": current, "max": max });
}

function gameOf(name?: string): Game {
  return name === "星铁" ? "sr" : name === "绝区零" ? "zzz" : "gs";
}

export function dailyNoteReminderBinding(source: ProfileRequestContext) {
  const { account, qq, profileId, game, role } = source;
  const id = source.international ? `os:${source.international.realm}:${source.international.accountId}` : profileCookieAccountId(account);
  const channel = role.uid.startsWith("5");
  const validRole = source.international ? /^[1-9]\d{7,9}$/u.test(role.uid) && (game === "gs" ? /^os_(?:usa|euro|asia|cht)$/u.test(role.region) : game === "sr" ? /^prod_official_(?:usa|eur|asia|cht)$/u.test(role.region) : /^prod_gf_(?:us|eu|jp|sg)$/u.test(role.region))
    : game === "zzz"
    ? /^[1-9]\d{7,8}$/u.test(role.uid) && /^prod_(?:gf|qd)_cn$/u.test(role.region)
    : /^[1-5]\d{8}$/u.test(role.uid) && role.region === (game === "gs"
      ? (channel ? "cn_qd01" : "cn_gf01") : (channel ? "prod_qd_cn" : "prod_gf_cn"));
  if (id && validRole && role.gameBiz === (source.international ? gameBusiness[game].replace("_cn", "_global") : gameBusiness[game])) {
    return createHash("sha256").update(JSON.stringify([qq, profileId, id, game, role.uid, role.region, role.gameBiz])).digest("hex");
  }
}

function databaseFile(file: string, create: boolean) {
  try {
    const info = lstatSync(file);
    if (!info.isFile()) throw new Error($t("lib.daily-note-reminders.text_0ff7b73de0"));
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
  if (!database) throw new Error($t("lib.daily-note-reminders.text_f9f2e4d147"));
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
  directory, file, signal, enabled, cooldownHours, cron, message, activeSignal, allowed, transports, transport, legacyTimeToLive, reminderImage, now = Date.now,
}: {
  readonly directory?: string;
  readonly file: string;
  readonly signal: AbortSignal;
  readonly enabled: boolean;
  readonly cooldownHours?: unknown;
  readonly cron?: unknown;
  readonly message?: unknown;
  readonly activeSignal: () => AbortSignal;
  readonly allowed: (target: Destination) => boolean;
  readonly transports: () => readonly BotNotifications[];
  readonly transport?: Parameters<typeof createProfileHoyoClient>[1];
  readonly legacyTimeToLive?: (key: string) => Promise<number | undefined>;
  readonly reminderImage?: ReminderImage;
  readonly now?: () => number;
}) {
  const cooldown = dailyNoteReminderCooldown(cooldownHours) ?? defaultCooldown;
  const prefix = dailyNoteReminderMessage(message);
  const profiles = createProfileStore(directory);
  const client = createProfileHoyoClient(profiles, transport);
  let database: Database | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let job: Job | undefined;
  let started = false;
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

  async function legacyCooldownActive(db: Database, target: Target, current: AbortSignal) {
    if (!target.legacyUntil) return false;
    const legacyKey = `${target.group_id}:${target.bot}:${target.game}_NoteTask:${target.uid}`;
    const ttl = await legacyCooldown(legacyKey, current);
    if (!active(current)) return true;
    if (typeof ttl === "number" && Number.isSafeInteger(ttl) && ttl > 0) {
      const at = now();
      const until = Math.min(Number.MAX_SAFE_INTEGER, at + ttl);
      db.query(`UPDATE daily_note_reminders SET nextAt=$until WHERE ${targetSql}
        AND binding=$binding AND legacyUntil=$legacyUntil AND nextAt <= $at`)
        .run({ ...groupKey(target), $uid: target.uid, $binding: target.binding, $legacyUntil: target.legacyUntil, $at: at, $until: until });
      return true;
    }
    return ttl === -1 || (ttl !== -2 && ttl !== 0 && now() < target.legacyUntil);
  }

  async function notifyGroup(db: Database, destination: Destination, candidates: readonly PendingNote[], gateway: BotNotifications, current: AbortSignal) {
    let claimed: readonly PendingNote[] = [];
    let until = 0;
    const result = await notifyCheckin({
      userId: destination.qq, transports: [gateway], signal: current,
      settings: { enabled: true, prefer: "group", fallbackGroups: [destination.group_id] },
      reply() {
        if (claimed.some(row => row.image)) {
          return [
            ...(prefix ? [segment.text(prefix + "\n")] : []),
            ...claimed.map(({ image, note }) => image ? segment.image(image) : segment.text(noticeDescription(note) + "\n")),
          ];
        }
        const text = [prefix, ...claimed.map(({ note }) => noticeDescription(note))].filter(Boolean).join("\n");
        return { type: "text", text };
      },
      async verifySend() {
        const verified = await Promise.all(candidates.map(async ({ target, note }) => (await sourceFor(target))?.revision === note.revision));
        if (!active(current) || !allowed(destination)) return false;
        const at = now();
        until = Math.min(Number.MAX_SAFE_INTEGER, at + cooldown);
        const claim = db.query(`UPDATE daily_note_reminders SET nextAt=$until WHERE ${targetSql}
          AND binding=$binding AND profile=$profile AND threshold=$threshold AND legacyUntil=$legacyUntil AND nextAt <= $at`);
        claimed = db.transaction(() => candidates.filter(({ target }, index) => verified[index] &&
          claim.run({ ...groupKey(target), $uid: target.uid, $binding: target.binding, $profile: target.profile,
            $threshold: target.threshold, $legacyUntil: target.legacyUntil, $at: at, $until: until }).changes === 1)).immediate();
        return claimed.length > 0;
      },
    });
    if (!claimed.length) return;
    const release = result.status === "unavailable" || result.status === "skipped";
    const update = db.query(`UPDATE daily_note_reminders SET ${release ? "nextAt=0" : "legacyUntil=0"}
      WHERE ${targetSql} AND binding=$binding AND nextAt=$until`);
    db.transaction(() => {
      for (const { target } of claimed) {
        update.run({ ...groupKey(target), $uid: target.uid, $binding: target.binding, $until: until });
      }
    }).immediate();
  }

  async function scan() {
    const current = activeSignal();
    if (!active(current)) return;
    const db = open(false);
    if (!db) return;
    const due = db.query<Target, [number]>(
      "SELECT * FROM daily_note_reminders WHERE nextAt <= ? ORDER BY bot,group_id,qq,game,uid").all(now());
    const groups = new Map<string, Target[]>();
    for (const target of due) {
      const key = `${target.bot}:${target.group_id}:${target.qq}`;
      const group = groups.get(key) ?? [];
      group.push(target);
      groups.set(key, group);
    }
    const readings = new Map<string, ReadNote | undefined>();
    for (const targets of groups.values()) {
      if (!active(current)) return;
      const destination = targets[0]!;
      if (!allowed(destination)) continue;
      const gateway = transports().find(item => item.botId === destination.bot);
      if (!gateway || !await gateway.isGroupMember(destination.group_id, destination.qq).catch(() => false)) continue;
      const candidates: PendingNote[] = [];
      for (const target of targets) {
        if (!active(current)) return;
        if (!allowed(destination)) break;
        if (await legacyCooldownActive(db, target, current)) continue;
        const key = target.binding;
        if (!readings.has(key)) readings.set(key, await readNote(target, current).catch(() => undefined));
        const note = readings.get(key);
        if (!note || note.snapshot.stamina.current < target.threshold) continue;
        const { game, stamina: { current: points, max } } = note.snapshot;
        const image = await reminderImage?.({ game, current: points, max }, { inlineImageByteLimit: gateway.inlineImageByteLimit, signal: current })
          .catch(() => undefined);
        candidates.push({ target, note, image });
      }
      if (!active(current)) return;
      if (candidates.length) await notifyGroup(db, destination, candidates, gateway, current);
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
        return $t("lib.daily-note-reminders.text_b59932a426");
      }
      if (!enabled) return $t("lib.daily-note-reminders.text_e0637c9a69");
      const current = activeSignal();
      const destination = { bot, group_id, qq };
      const gateway = transports().find(item => item.botId === bot);
      const eligible = () => active(current) && allowed(destination);
      if (!eligible() || !gateway || !await gateway.isGroupMember(group_id, qq).catch(() => false) || !eligible()) return;
      const game = gameOf((action ?? level)?.[1]);
      const label = $t("lib.daily-note-reminders.text_a9748d0afa", { "value1": gameNames[game] });
      const key = groupKey({ ...destination, game });
      const profile = action?.[4] ? Number(action[4]) : undefined;
      if (profile && profile > MAX_PROFILE_ID) return $t("lib.daily-note-reminders.text_3dd62228d2");
      const uid = action?.[3];
      try {
        if (level) {
          const value = Number(level[2]);
          if (value < minimum[game]) return $t("lib.daily-note-reminders.text_a59d15b8c3", { "label": label, "value2": minimum[game] });
          const changed = open(false)?.query(`UPDATE daily_note_reminders SET threshold=$threshold WHERE ${actorSql}`)
            .run({ ...key, $threshold: value }).changes;
          return changed ? $t("lib.daily-note-reminders.text_0f46f3072c", { "label": label, "value": value }) : $t("lib.daily-note-reminders.text_46a3e63a35", { "label": label });
        }
        if (action?.[2] === "关闭") {
          const changed = open(false)?.query(`DELETE FROM daily_note_reminders WHERE ${actorSql}
            AND ($uid IS NULL OR uid=$uid) AND ($profile IS NULL OR profile=$profile)`)
            .run({ ...key, $uid: uid ?? null, $profile: profile ?? null }).changes;
          return changed ? $t("lib.daily-note-reminders.text_5ce0ab30b3", { "label": label }) : $t("lib.daily-note-reminders.text_46a3e63a35", { "label": label });
        }
        const user = String(qq);
        const selectable = new Map<string, { source: ProfileRequestContext; binding: string }>();
        for (const id of profile ? [profile] : await profiles.listIds(user)) {
          const roles = await profiles.requestContexts(user, id, [game]).catch(() => []);
          for (const source of roles) {
            if (uid && source.role.uid !== uid) continue;
            const binding = dailyNoteReminderBinding(source);
            if (!binding) continue;
            if (selectable.has(source.role.uid)) return $t("lib.daily-note-reminders.text_ab02af4fa4");
            selectable.set(source.role.uid, { source, binding });
          }
        }
        if (!selectable.size) return $t("lib.daily-note-reminders.text_15d3f1efa8");
        for (const [roleUid, { source, binding }] of selectable) {
          const fresh = await sourceFor({ ...destination, game, uid: roleUid, profile: source.profileId, binding,
            threshold: defaults[game], nextAt: 0, legacyUntil: 0 });
          if (fresh?.revision !== source.revision || !eligible()) return $t("lib.daily-note-reminders.text_ffc7f03b5b");
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
        return $t("lib.daily-note-reminders.text_657d6aa336", { "label": label, "size": selectable.size, "value": value });
      } catch {
        return $t("lib.daily-note-reminders.text_f4a256ce5a");
      }
    },
  };

  return {
    commands, runDue,
    start() {
      if (!enabled || stopped || started || signal.aborted) return;
      started = true;
      const tick = () => withCaptchaInteraction(() => false, () => runDue()?.catch(() => console.warn($t("lib.daily-note-reminders.text_fa17cc2548"))));
      if (cron !== undefined) {
        job = reminderJob(cron, tick);
        if (!job) console.warn($t("lib.daily-note-reminders.text_406611c259"));
      } else {
        timer = setInterval(() => { void tick(); }, pollInterval);
        timer.unref();
      }
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      job?.cancel();
      await running?.catch(() => {});
      database?.close();
      database = undefined;
    },
  };
}
