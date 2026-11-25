import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { accountScopePolicies, accountScopePolicy, accountScopes, type AccountScope, type GroupScope, type RemoteScope } from "./account-scope-policy.ts";
import { readLocalConfig } from "./config.ts";
import { watchConfigFiles } from "./config-watch.ts";
import { readLotusGlobalConfig } from "./lotus-global-config.ts";
import { persistMaster } from "./master-config.ts";

export function readOwnerSnapshot(config: Readonly<Record<string, unknown>>) {
  const owners = new Map<string, Set<string>>();
  const { master, masterQQ } = config;
  const entries = Array.isArray(master) ? master : master == null ? [] : [master];
  for (const entry of entries) {
    const match = typeof entry === "string" ? /^(stdin|[1-9]\d*):(stdin|[1-9]\d*)$/u.exec(entry.trim()) : null;
    const bot = match?.[1];
    const user = match?.[2];
    if (!bot || !user || (bot === "stdin") !== (user === "stdin")) {
      throw new Error($t("lib.permissions.text_bb5dfed55c"));
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

export async function readMasterPermissions(root: URL, signal?: AbortSignal) {
  const read = async () => readOwnerSnapshot(await readLocalConfig(root, "other"));
  let snapshot = await read();
  let revision = 0;
  if (signal) {
    watchConfigFiles(signal, async () => {
      while (!signal.aborted) {
        const before = revision;
        const updated = await read();
        if (revision !== before) continue;
        if (!signal.aborted) snapshot = updated;
        break;
      }
    }, () => console.warn($t("lib.permissions.text_b30350bfea")));
  }
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
        const updated = readOwnerSnapshot(config);
        // A reload that began before this successful write must not restore an older owner list.
        revision++;
        snapshot = updated;
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

export function accountScopePermission(document: Readonly<Record<string, unknown>>, permission: AccountScope | GroupScope | RemoteScope) {
  const permissions = configRecord(document.permissions);
  const configured = configRecord(permissions.scopes)[permission];
  const defaultPolicy = permissions.default_policy;
  if (accountScopes.some(scope => scope === permission) && (
      [document.permissions, permissions.scopes, configured].some(value => value != null && configRecord(value) !== value) ||
      (defaultPolicy != null && !accountScopePolicies.some(policy => policy === defaultPolicy)))) {
    return () => false;
  }
  const users = configRecord(permissions.users);
  const groups = configRecord(permissions.groups);
  const userAllow = configuredIds(users.allow);
  const userDeny = configuredIds(users.deny);
  const groupAllow = configuredIds(groups.allow);
  const groupDeny = configuredIds(groups.deny);
  const scope = accountScopePolicy(permission, configRecord(configured).policy);
  return (context: { user_id?: number; group_id?: number; isMaster: boolean }) => {
    const user = String(context.user_id ?? "");
    const group = String(context.group_id ?? "");
    if (userDeny.has(user) || groupDeny.has(group) || scope === "deny") return false;
    if (scope === "master_only") return context.isMaster;
    return scope === "allow" || userAllow.has(user) || groupAllow.has(group) || defaultPolicy !== "deny";
  };
}

export async function readAccountScopePermission(root: URL, permission: AccountScope) {
  return accountScopePermission(await readLotusGlobalConfig(root), permission);
}

export function readAccountRefreshPermission(root: URL) {
  return readAccountScopePermission(root, "checkin.refresh");
}
