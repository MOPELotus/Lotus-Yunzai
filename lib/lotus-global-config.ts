import { readOptionalLocalConfig } from "./config.ts";

export const legacyLotusDirectories = ["Lotus-Plugin", "Lotus-ReFactor"] as const;
const inheritedSections = ["atlas", "scheduler", "coin_shop", "permissions"] as const;

type Config = Record<string, unknown>;

function section(value: unknown): Config | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Config;
}

function configList(value: unknown) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function legacyPermissionList(...sources: unknown[]) {
  return [...new Set(sources.flatMap(configList).map(String).filter(Boolean))];
}

function normalizeLotusGlobalConfig(raw: Readonly<Config>): Config {
  const normalized = { ...raw };
  if (typeof raw.schedule === "string") {
    const fields = raw.schedule.trim().split(/\s+/u);
    const offset = fields.length >= 6 ? 1 : 0;
    const minute = Number(fields[offset]);
    const hour = Number(fields[offset + 1]);
    if (fields.length >= 5 && Number.isInteger(minute) && minute >= 0 && minute <= 59 &&
        Number.isInteger(hour) && hour >= 0 && hour <= 23) {
      const scheduler = section(raw.scheduler) ?? {};
      const fixedTime = [hour, minute].map(value => String(value).padStart(2, "0")).join(":");
      normalized.scheduler = { ...scheduler, mode: scheduler.mode || "fixed", fixed_time: scheduler.fixed_time || fixedTime };
    }
  }

  const checkin = section(raw.checkin);
  const control = section(raw.permissionControl || raw.permission_control || checkin?.permissionControl || checkin?.permission_control);
  if (control) {
    const permissions = section(raw.permissions) ?? {};
    const users = section(permissions.users) ?? {};
    const mode = String(control.mode ?? "").toLowerCase();
    normalized.permissions = {
      ...permissions,
      default_policy: permissions.default_policy || (mode.includes("white") || mode.includes("deny") ? "deny" : "allow"),
      users: {
        ...users,
        allow: legacyPermissionList(control.whitelist, control.whiteList, control.white_list, users.allow),
        deny: legacyPermissionList(control.blacklist, control.blackList, control.black_list, users.deny),
      },
    };
  }

  return normalized;
}

function overlayPermissions(historical: Config, local: Config): Config {
  const merged = { ...historical, ...local };
  for (const key of ["users", "groups", "scopes"]) {
    const oldFields = section(historical[key]);
    const newFields = section(local[key]);
    if (!oldFields || !newFields) continue;
    const fields = { ...oldFields, ...newFields };
    if (key === "scopes") for (const [scope, value] of Object.entries(newFields)) {
      const oldRule = section(oldFields[scope]);
      const newRule = section(value);
      if (oldRule && newRule) fields[scope] = { ...oldRule, ...newRule };
    }
    merged[key] = fields;
  }
  return merged;
}

export async function resolveLotusGlobalConfig(current: Readonly<Config>,
  readLegacy: (id: (typeof legacyLotusDirectories)[number]) => Promise<Config | undefined>) {
  const local = normalizeLotusGlobalConfig(current);
  const inherited: Config = {};
  const localScheduler = section(local.scheduler);
  const localPermissions = section(local.permissions);
  for (const id of legacyLotusDirectories) {
    const pending = inheritedSections.filter(key => !Object.hasOwn(inherited, key) &&
      (!Object.hasOwn(local, key) || (key === "scheduler" && localScheduler) || (key === "permissions" && localPermissions)));
    if (!pending.length) break;
    const raw = await readLegacy(id);
    if (!raw) continue;
    const legacy = normalizeLotusGlobalConfig(raw);
    for (const key of pending) {
      if (Object.hasOwn(legacy, key)) inherited[key] = legacy[key];
    }
  }
  const merged = { ...inherited, ...local };
  const legacyScheduler = section(inherited.scheduler);
  const legacyPermissions = section(inherited.permissions);
  if (legacyScheduler && localScheduler) merged.scheduler = { ...legacyScheduler, ...localScheduler };
  if (legacyPermissions && localPermissions) merged.permissions = overlayPermissions(legacyPermissions, localPermissions);
  return merged;
}

export async function inheritLotusGlobalConfig(root: URL, current: Readonly<Config>) {
  return resolveLotusGlobalConfig(current, id => readOptionalLocalConfig(new URL(`plugins/${id}/`, root), "global"));
}

export async function readLotusGlobalConfig(root: URL) {
  return inheritLotusGlobalConfig(root, await readOptionalLocalConfig(root, "global") ?? {});
}
