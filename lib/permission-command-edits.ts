import { fileURLToPath } from "node:url";
import { accountScopePolicies, accountScopes, groupExportScopes, mediaDownloadScopes, mediaOwnerScopePolicies,
  mediaOwnerScopes, type AccountScopePolicy } from "./account-scope-policy.ts";
import { appendPrivateAuditLine } from "./checkin-audit.ts";
import { isPermissionId, sortPermissionIds, type GlobalPermissionPolicy } from "./global-permission-policy.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { editAccountScopePolicies } from "./panel-account-permissions.ts";
import { editGlobalPermissionSettings, globalPermissionSnapshot, LegacyPermissionAlias, type GlobalPermissionChanges } from "./panel-global-permissions.ts";

type ListAction = "allow" | "deny" | "remove";
type Subject = "users" | "groups";
type Edit = { readonly type: "defaultPolicy"; readonly policy: GlobalPermissionPolicy } |
  { readonly type: "listUpdate"; readonly action: ListAction; readonly subject: Subject; readonly id: string } |
  { readonly type: "scopePolicy"; readonly scope: string; readonly policy: AccountScopePolicy };

const allowedScopes: readonly string[] = [...accountScopes, ...groupExportScopes, "group.cleanup", ...mediaDownloadScopes];
const restartScopes: readonly string[] = accountScopes.filter(scope => scope !== "scheduler.manage");
const restartNote = "签到注册、登录信息刷新、计划生成和执行在宿主重启后采用新设置。";
const aliases: Readonly<Record<string, AccountScopePolicy>> = {
  允许: "allow", 拒绝: "deny", 继承: "inherit", 主人: "master_only", 主人限定: "master_only", master: "master_only",
};

export function parsePermissionEdit(text: string): Edit | "invalid" | "unsupported" | undefined {
  const mode = /^#自动签到([黑白])名单$/u.exec(text);
  if (mode) return { type: "defaultPolicy", policy: mode[1] === "白" ? "deny" : "allow" };

  const scope = /^#权限设置\s+([\w.-]+)\s+([\w\u4e00-\u9fa5_]+)$/u.exec(text);
  if (scope) {
    const [, key = "", definition = ""] = scope;
    const knownOwner = mediaOwnerScopes.find(item => item === key);
    if (!knownOwner && !allowedScopes.includes(key)) return "unsupported";
    const policies = knownOwner ? mediaOwnerScopePolicies(knownOwner) : accountScopePolicies;
    const normalized = definition.toLowerCase();
    const policy = policies.find(item => item === normalized || item === aliases[normalized]);
    return policy ? { type: "scopePolicy", scope: key, policy } : "invalid";
  }

  const list = /^#权限(允许|拒绝|移除)(用户|群)\s+(.+)$/u.exec(text);
  const alternate = /^#权限(用户|群)(白名单|黑名单|移除)\s+(.+)$/u.exec(text);
  const legacyList = /^#(添加|删除)(黑|白)名单\s*(.+)$/u.exec(text);
  if (!list && !alternate && !legacyList) return;
  const verb = list?.[1] ?? alternate?.[2];
  const action: ListAction = verb === "允许" || verb === "白名单" || legacyList?.[1] === "添加" && legacyList[2] === "白" ? "allow" :
    verb === "拒绝" || verb === "黑名单" || legacyList?.[1] === "添加" && legacyList[2] === "黑" ? "deny" : "remove";
  const subject: Subject = (list?.[2] ?? alternate?.[1]) === "群" ? "groups" : "users";
  const id = (list?.[3] ?? alternate?.[3] ?? legacyList?.[3] ?? "").trim().replace(/^@/u, "");
  return isPermissionId(id) ? { type: "listUpdate", action, subject, id } : "invalid";
}

export async function editChatPermissions(root: URL, edit: Edit, session: {
  readonly active: () => boolean; readonly signal: AbortSignal; readonly actor: string; readonly group?: number;
}): Promise<{ readonly note: string; readonly changed: boolean } | string> {
  if (!session.active()) return "当前会话不能修改业务权限。";
  const path = fileURLToPath(new URL("data/audit/permissions.jsonl", root));
  const entry = { actor: session.actor, group: session.group === undefined ? "" : String(session.group), command: edit, operation: crypto.randomUUID() };
  function audit(phase: "plan" | "result", result: string) {
    return appendPrivateAuditLine(path, { time: new Date().toISOString(), ...entry, phase, result });
  }
  try { await audit("plan", "pending"); }
  catch { return "无法记录业务权限操作，配置未修改。"; }

  let changed: boolean;
  try {
    changed = await updateLotusGlobalConfig(root, {
      signal: session.signal, canWrite: session.active, canCommit: session.active,
      prepare(text, local, effective) {
        let yaml: string | undefined;
        if (edit.type === "scopePolicy") {
          const scopes = effective.permissions && typeof effective.permissions === "object" && "scopes" in effective.permissions
            ? effective.permissions.scopes : undefined;
          const previous = scopes && typeof scopes === "object" ? (scopes as Record<string, unknown>)[edit.scope] : undefined;
          if (!previous || typeof previous !== "object" || !("policy" in previous) || previous.policy !== edit.policy) {
            yaml = editAccountScopePolicies(text, local, { [edit.scope]: edit.policy });
          }
        } else {
          const before = globalPermissionSnapshot(local, effective);
          let patch: GlobalPermissionChanges;
          if (edit.type === "defaultPolicy") patch = { default_policy: edit.policy };
          else {
            const allow = `${edit.subject}.allow` as const;
            const deny = `${edit.subject}.deny` as const;
            const allowed = before.settings[allow].filter(id => id !== edit.id);
            const denied = before.settings[deny].filter(id => id !== edit.id);
            if (edit.action === "allow") allowed.push(edit.id);
            if (edit.action === "deny") denied.push(edit.id);
            patch = { [allow]: sortPermissionIds(allowed), [deny]: sortPermissionIds(denied) };
          }
          yaml = editGlobalPermissionSettings(text, local, effective, patch, before);
        }
        return { yaml, value: yaml !== undefined };
      },
    });
  } catch (error) {
    await audit("result", "rejected").catch(() => {});
    if (error instanceof LegacyPermissionAlias) return "该号码仍由旧配置固定，无法从当前名单移除。";
    if (error instanceof GlobalConfigWriteError && error.reason === "conflict") return "权限配置已在别处修改，请重试。";
    return "未能修改业务权限，请检查当前配置和授权。";
  }
  try { await audit("result", changed ? "ok" : "unchanged"); }
  catch { return changed ? "配置已保存，操作结果未写入审计。操作计划已留存。" : "未修改配置，操作结果未写入审计。"; }
  if (!changed) return { note: "权限配置已经是指定状态。", changed };
  if (edit.type === "defaultPolicy") {
    return { note: `已切换到${edit.policy === "deny" ? "白名单" : "黑名单"}模式，影响继承全局权限的业务。\n${restartNote}`, changed };
  }
  if (edit.type === "scopePolicy") {
    const notice = restartScopes.includes(edit.scope) ? "宿主重启后采用新设置。" : "";
    return { note: `已将 ${edit.scope} 设为 ${edit.policy}。${notice}`, changed };
  }
  const action = edit.action === "allow" ? "允许" : edit.action === "deny" ? "拒绝" : "移除";
  return { note: `已${action}${edit.subject === "groups" ? "群" : "用户"} ${edit.id}。\n${restartNote}`, changed };
}
