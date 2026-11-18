import { readLocalConfig } from "./config.ts";

export async function readMasterPermissions(root: URL) {
  const owners = new Map<string, Set<string>>();
  const { master } = await readLocalConfig(root, "other");
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

  return {
    terminal: owners.get("stdin")?.has("stdin") ?? false,
    isMaster(bot: number, user: number) {
      return owners.get(String(bot))?.has(String(user)) ?? false;
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

export async function readAccountRefreshPermission(root: URL) {
  const permissions = configRecord((await readLocalConfig(root, "global")).permissions);
  const users = configRecord(permissions.users);
  const groups = configRecord(permissions.groups);
  const userAllow = configuredIds(users.allow);
  const userDeny = configuredIds(users.deny);
  const groupAllow = configuredIds(groups.allow);
  const groupDeny = configuredIds(groups.deny);
  const scope = configRecord(configRecord(permissions.scopes)["checkin.refresh"]).policy;
  return (context: { user_id?: number; group_id?: number; isMaster: boolean }) => {
    const user = String(context.user_id ?? "");
    const group = String(context.group_id ?? "");
    if (userDeny.has(user) || groupDeny.has(group) || scope === "deny") return false;
    if (scope === "master_only") return context.isMaster;
    return scope === "allow" || userAllow.has(user) || groupAllow.has(group) || permissions.default_policy !== "deny";
  };
}
