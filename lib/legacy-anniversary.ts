import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import { ownOperationSession } from "./own-operation-session.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createProfileHoyoClient } from "@lotus-yunzai/hoyo-client";
import { mkdir, lstat, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProfileStore, type Game, type GameRole, type ProfileRequestContext } from "@lotus-yunzai/account";
import type { CommandModule } from "./commands.ts";
import { readMigrationSourceFile } from "./migration-files.ts";

const commandPattern = /^#?(原神|星铁|绝区零)?(刷新)?(?:我的)?(原神|星铁|绝区零)?注册时间$/u;
const games = { 原神: "gs", 星铁: "sr", 绝区零: "zzz" } as const;
const folders = { gs: "ys_RegTime", sr: "sr_RegTime", zzz: "zzz_RegTime" } as const;
const maxArchiveBytes = 512 * 1024;
const firstDate = Date.UTC(2000, 0, 1);
const dateTime = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" });

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "string" && /^\d{1,13}$/u.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function registrationData(value: unknown, game: Game) {
  const wrapper = object(object(value)?.data);
  const payload = game === "gs" && wrapper?.data !== undefined ? wrapper.data : value;
  return object(typeof payload === "string" ? JSON.parse(payload) : payload);
}

function calendarDate(value: unknown, queriedAt: number) {
  if (typeof value !== "string") return;
  const match = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/u.exec(value);
  if (!match) return;
  const [, rawYear, rawMonth, rawDay] = match;
  const [year, month, day] = [Number(rawYear), Number(rawMonth), Number(rawDay)];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getTime() >= firstDate && date.getTime() - 8 * 3600_000 <= queriedAt &&
      date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day) {
    return date.toISOString().slice(0, 10);
  }
}

function readEntry(value: unknown, role: GameRole, game: Game) {
  const entry = object(value);
  const info = object(entry?.info_data);
  const cachedUid = info?.game_uid ?? info?.uid;
  if ((typeof cachedUid !== "number" && typeof cachedUid !== "string") || String(cachedUid) !== role.uid ||
      !role.region || info?.region !== role.region || (role.gameBiz && info.game_biz !== role.gameBiz)) return;
  const queriedAt = positiveInteger(entry?.query_time);
  if (!queriedAt || queriedAt < firstDate || queriedAt > Date.now()) return;
  let data: ReturnType<typeof registrationData>;
  try {
    data = registrationData(entry?.game_data, game);
  } catch {
    return;
  }
  if (!data) return;
  let registeredAt: string | undefined;
  if (game === "sr") {
    const list = object(data.data)?.list;
    const registerDate = Array.isArray(list) ? list.find(row => object(row)?.key === "register_date") : undefined;
    registeredAt = calendarDate(data["1-1"] ?? data.th_1_1_1 ?? object(registerDate)?.value, queriedAt);
  } else {
    const candidates = game === "gs" ? [data["1"], data["1-1-1"]] : [data["1"]];
    for (const value of candidates) {
      const seconds = positiveInteger(value);
      if (seconds && seconds * 1000 >= firstDate && seconds * 1000 <= queriedAt) {
        registeredAt = dateTime.format(seconds * 1000);
        break;
      }
      if (game === "gs" && (registeredAt = calendarDate(value, queriedAt))) break;
    }
  }
  if (registeredAt) return { registeredAt, queriedAt: dateTime.format(queriedAt) };
}

const anniversaryWrites = new Map<string, Promise<void>>();

export function createAnniversaryStore(root: string) {
  const path = (game: Game, qq: string) => {
    if (!/^[1-9]\d{0,15}$/u.test(qq)) throw new Error($t("lib.legacy-anniversary.text_c70459fe27"));
    return join(root, "data", "anniversary", game, qq + ".json");
  };
  return {
    async read(game: Game, qq: string, signal: AbortSignal) {
      const file = await readMigrationSourceFile(root, path(game, qq), maxArchiveBytes, signal);
      return file ? object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))) : undefined;
    },
    save(game: Game, qq: string, role: GameRole, value: unknown, signal: AbortSignal): Promise<void> {
      const key = path(game, qq);
      const work = (anniversaryWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!readEntry(value, role, game)) throw new Error($t("lib.legacy-anniversary.text_a6bf8e5883"));
      const file = path(game, qq), directory = dirname(file);
      for (const part of [join(root, "data"), join(root, "data/anniversary"), directory]) {
        await mkdir(part, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
        if (!(await lstat(part)).isDirectory() || (await lstat(part)).isSymbolicLink()) throw new Error($t("lib.legacy-anniversary.text_c18bcb95b3"));
      }
      const current = await this.read(game, qq, signal) ?? {};
      const entry = object(value)!;
      // Only the activity payload and role identity are retained; never copy account credentials or legacy user labels.
      current[role.uid] = { info_data: { game_uid: role.uid, region: role.region, game_biz: role.gameBiz },
        game_data: entry.game_data, query_time: entry.query_time };
      const text = JSON.stringify(current);
      if (Buffer.byteLength(text) > maxArchiveBytes) throw new Error($t("lib.legacy-anniversary.text_592fe13da1"));
      const temporary = file + "." + crypto.randomUUID() + ".tmp";
      try {
        signal.throwIfAborted();
        await writeFile(temporary, text, { flag: "wx", mode: 0o600, signal });
        signal.throwIfAborted();
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
      });
      anniversaryWrites.set(key, work);
      return work.finally(() => { if (anniversaryWrites.get(key) === work) anniversaryWrites.delete(key); });
    },
  };
}

async function readArchive(root: string, game: Game, qq: string, signal: AbortSignal) {
  const native = await createAnniversaryStore(root).read(game, qq, signal) ?? {};
  for (const location of ["plugins", "backup/plugins"]) {
    const path = join(root, location, "xiaofei-plugin", "data", folders[game], qq + ".json");
    const file = await readMigrationSourceFile(root, path, maxArchiveBytes, signal);
    if (file) {
      const legacy = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)));
      for (const [key, value] of Object.entries(legacy ?? {})) if (!Object.hasOwn(native, key)) native[key] = value;
    }
  }
  return native;
}

export interface AnniversaryOptions {
  /** Provider performs the activity login/read using the existing account transport; no credentials are persisted here. */
  readonly request?: (source: ProfileRequestContext, game: Game, signal: AbortSignal) => Promise<unknown>;
}

export function legacyAnniversaryCommands(root: URL, directory: string | undefined, signal: AbortSignal, options: AnniversaryOptions = {}): CommandModule {
  const installation = fileURLToPath(root);
  const profiles = createProfileStore(directory);
  const client = createProfileHoyoClient(profiles);
  const request = options.request ?? ((source: ProfileRequestContext, _game: Game, active: AbortSignal) => client.fetchRegistrationTime(source, { signal: active }));
  return {
    name: "@lotus-yunzai/legacy-anniversary",
    commands: {},
    fallbackFeatures: context => commandPattern.test(context.normalizedMessage) ? [$t("lib.legacy-anniversary.text_8ae4ecd14a")] : [],
    async fallback(_message, context) {
      const match = commandPattern.exec(context.normalizedMessage);
      if (!match || signal.aborted || context.isDelegated) return;
      const [, prefix, refresh, suffix] = match;
      if (prefix && suffix && prefix !== suffix) return;
      const session = ownOperationSession(context);
      if (!session) return;
      const { user } = session;
      const active = AbortSignal.any([signal, session.signal]);
      const name = (prefix ?? suffix ?? $t("lib.legacy-anniversary.text_d1597c51ed")) as keyof typeof games;
      const game = games[name];
      const qq = String(user);
      try {
        const ids = await profiles.listIds(qq);
        const contexts: ProfileRequestContext[] = [];
        for (const id of ids) {
          active.throwIfAborted();
          contexts.push(...await profiles.requestContexts(qq, id, [game]).catch(() => []));
        }
        active.throwIfAborted();
        if (!contexts.length) return $t("lib.legacy-anniversary.text_c901a7641b");
        const hint = "";
        const archive = await readArchive(installation, game, qq, active);
        const entries = [];
        for (const source of contexts) {
          active.throwIfAborted();
          let value = archive?.[source.role.uid];
          if (refresh || !readEntry(value, source.role, game)) {
            value = await request(source, game, active);
          }
          const cached = readEntry(value, source.role, game);
          if (cached) {
            const updated = object(value)?.revision;
            entries.push({ ...source, ...(typeof updated === "string" && { revision: updated }), value, ...cached });
          }
        }
        if (!entries.length) return $t("lib.legacy-anniversary.text_657dc1fe8c", { "name": name, "hint": hint });
        for (const { profileId, role, revision, value } of entries) {
          active.throwIfAborted();
          const current = await profiles.requestContext(qq, profileId, game, role.uid).catch(() => undefined);
          if (current?.revision !== revision) return;
          await createAnniversaryStore(installation).save(game, qq, role, value, active);
        }
        active.throwIfAborted();
        return [
          $t("lib.legacy-anniversary.text_ee08621dc1", { "name": name }),
          ...entries.map(({ profileId, registeredAt, queriedAt }) => $t("lib.legacy-anniversary.text_c52ea0d3db", { "profileId": profileId, "registeredAt": registeredAt, "queriedAt": queriedAt })),
        ].join("\n") + hint;
      } catch {
        return active.aborted ? undefined : $t("lib.legacy-anniversary.text_5a3bee191c");
      }
    },
  };
}
