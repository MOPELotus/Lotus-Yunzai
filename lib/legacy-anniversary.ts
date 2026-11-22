import { join } from "node:path";
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

async function readArchive(root: string, game: Game, qq: string, signal: AbortSignal) {
  for (const location of ["backup/plugins", "plugins"]) {
    const path = join(root, location, "xiaofei-plugin", "data", folders[game], qq + ".json");
    const file = await readMigrationSourceFile(root, path, maxArchiveBytes, signal);
    if (file) return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)));
  }
}

export function legacyAnniversaryCommands(root: URL, directory: string | undefined, signal: AbortSignal): CommandModule {
  const installation = fileURLToPath(root);
  const profiles = createProfileStore(directory);
  return {
    name: "@lotus-yunzai/legacy-anniversary",
    commands: {},
    fallbackFeatures: context => commandPattern.test(context.normalizedMessage) ? ["游戏注册时间"] : [],
    async fallback(_message, context) {
      const match = commandPattern.exec(context.normalizedMessage);
      if (!match || signal.aborted || context.isDelegated) return;
      const [, prefix, refresh, suffix] = match;
      if (prefix && suffix && prefix !== suffix) return;
      if (context.message_type === "group") return "请在本人好友私聊查询游戏注册时间。";
      const { privateCredentialSignal, user_id: user } = context;
      if (context.message_type !== "private" || !privateCredentialSignal || privateCredentialSignal.aborted ||
          user === undefined || !Number.isSafeInteger(user) || user < 1) return;
      const active = AbortSignal.any([signal, privateCredentialSignal]);
      const name = (prefix ?? suffix ?? "原神") as keyof typeof games;
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
        if (!contexts.length) return "请先登录并同步本人的游戏档案。";
        const hint = refresh ? "\n当前只可查询旧缓存，活动在线更新尚未接入。" : "";
        const archive = await readArchive(installation, game, qq, active);
        const entries = contexts.flatMap(({ profileId, role, revision }) => {
          const cached = readEntry(archive?.[role.uid], role, game);
          return cached ? [{ profileId, role, revision, ...cached }] : [];
        });
        if (!entries.length) return `未找到与当前档案匹配的${name}注册时间旧缓存。${hint}`;
        for (const { profileId, role, revision } of entries) {
          active.throwIfAborted();
          const current = await profiles.requestContext(qq, profileId, game, role.uid).catch(() => undefined);
          if (current?.revision !== revision) return;
        }
        active.throwIfAborted();
        return [
          `${name}注册时间（旧缓存，UTC+8）`,
          ...entries.map(({ profileId, registeredAt, queriedAt }) => `档案 ${profileId} · 注册时间 ${registeredAt} · 缓存查询时间 ${queriedAt}`),
        ].join("\n") + hint;
      } catch {
        return active.aborted ? undefined : "无法安全读取游戏注册时间旧缓存。";
      }
    },
  };
}
