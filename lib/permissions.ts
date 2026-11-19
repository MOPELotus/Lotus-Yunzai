import { readLocalConfig } from "./config.ts";
import { persistMaster } from "./master-config.ts";

function readOwnerSnapshot(config: Record<string, unknown>) {
  const owners = new Map<string, Set<string>>();
  const { master, masterQQ } = config;
  const entries = Array.isArray(master) ? master : master == null ? [] : [master];
  for (const entry of entries) {
    const match = typeof entry === "string" ? /^(stdin|[1-9]\d*):(stdin|[1-9]\d*)$/u.exec(entry.trim()) : null;
    const bot = match?.[1];
    const user = match?.[2];
    if (!bot || !user || (bot === "stdin") !== (user === "stdin")) {
      throw new Error("other.yaml 的 master 须为机器人账号:主人账号，终端可使用 stdin:stdin。");
    }
    const users = owners.get(bot) ?? new Set<string>();
    users.add(user);
    owners.set(bot, users);
  }

  const legacy = Array.isArray(masterQQ) ? masterQQ : [masterQQ];
  const globalMasters = legacy.flatMap((value) => {
    const id = typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value) : value;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? [id] : [];
  });
  return { owners, globalMasters };
}

export async function readMasterPermissions(root: URL) {
  let snapshot = readOwnerSnapshot(await readLocalConfig(root, "other"));
  return {
    get terminal() {
      return snapshot.owners.get("stdin")?.has("stdin") ?? false;
    },
    isMaster(bot: number, user: number) {
      return snapshot.owners.get(String(bot))?.has(String(user)) ?? false;
    },
    masterIds(bot: number): readonly number[] {
      return [...snapshot.owners.get(String(bot)) ?? []].map(Number).filter(Number.isSafeInteger);
    },
    botIds(): readonly number[] {
      return [...snapshot.owners.keys()].map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
        .sort((left, right) => left - right);
    },
    legacyMasterIds(): readonly number[] {
      return snapshot.globalMasters;
    },
    async grant(bot: number, user: number, approver: number | "stdin", isCurrent?: () => boolean): Promise<boolean> {
      try {
        const config = await persistMaster(root, bot, user, approver, isCurrent);
        snapshot = readOwnerSnapshot(config);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function configRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function configuredIds(value: unknown): Set<string> {
  const ids = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return new Set(ids.map((id) => String(id).trim()).filter((id) => /^[1-9]\d*$/u.test(id)));
}

export async function readAccountScopePermission(root: URL,
  permission: "checkin.refresh" | "checkin.register" | "checkin.group_register" | "scheduler.generate" | "scheduler.run_due") {
  const permissions = configRecord((await readLocalConfig(root, "global")).permissions);
  const users = configRecord(permissions.users);
  const groups = configRecord(permissions.groups);
  const userAllow = configuredIds(users.allow);
  const userDeny = configuredIds(users.deny);
  const groupAllow = configuredIds(groups.allow);
  const groupDeny = configuredIds(groups.deny);
  const scope = configRecord(configRecord(permissions.scopes)[permission]).policy ??
    (permission.startsWith("scheduler.") || permission === "checkin.group_register" ? "master_only" : undefined);
  return (context: { user_id?: number; group_id?: number; isMaster: boolean }) => {
    const user = String(context.user_id ?? "");
    const group = String(context.group_id ?? "");
    if (userDeny.has(user) || groupDeny.has(group) || scope === "deny") return false;
    if (scope === "master_only") return context.isMaster;
    return scope === "allow" || userAllow.has(user) || groupAllow.has(group) || permissions.default_policy !== "deny";
  };
}

export function readAccountRefreshPermission(root: URL) {
  return readAccountScopePermission(root, "checkin.refresh");
}
