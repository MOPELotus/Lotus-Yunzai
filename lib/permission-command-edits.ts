import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
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
const restartNote = $t("lib.permission-command-edits.text_25b5aee137");
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
  if (!session.active()) return $t("lib.permission-command-edits.text_2ed34cb807");
  const path = fileURLToPath(new URL("data/audit/permissions.jsonl", root));
  const entry = { actor: session.actor, group: session.group === undefined ? "" : String(session.group), command: edit, operation: crypto.randomUUID() };
  function audit(phase: "plan" | "result", result: string) {
    return appendPrivateAuditLine(path, { time: new Date().toISOString(), ...entry, phase, result });
  }
  try { await audit("plan", "pending"); }
  catch { return $t("lib.permission-command-edits.text_7a276a6b98"); }

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
    if (error instanceof LegacyPermissionAlias) return $t("lib.permission-command-edits.text_a43412628b");
    if (error instanceof GlobalConfigWriteError && error.reason === "conflict") return $t("lib.permission-command-edits.text_9f1dfa2b8c");
    return $t("lib.permission-command-edits.text_ac358dfadf");
  }
  try { await audit("result", changed ? "ok" : "unchanged"); }
  catch { return changed ? $t("lib.permission-command-edits.text_14e46522c2") : $t("lib.permission-command-edits.text_219bbb5fbe"); }
  if (!changed) return { note: $t("lib.permission-command-edits.text_eb8f8d3ab2"), changed };
  if (edit.type === "defaultPolicy") {
    return { note: $t("lib.permission-command-edits.text_94fd7bd339", { "value1": edit.policy === "deny" ? $t("lib.permission-command-edits.text_27e2d9e2d9") : $t("lib.permission-command-edits.text_174ec5a4ab"), "restartNote": restartNote }), changed };
  }
  if (edit.type === "scopePolicy") {
    const notice = restartScopes.includes(edit.scope) ? $t("lib.permission-command-edits.text_e45d7b8e16") : "";
    return { note: $t("lib.permission-command-edits.text_a13c99fa66", { "scope": edit.scope, "policy": edit.policy, "notice": notice }), changed };
  }
  const action = edit.action === "allow" ? $t("lib.permission-command-edits.text_ce7ef28b67") : edit.action === "deny" ? $t("lib.permission-command-edits.text_136de7a8c4") : $t("lib.permission-command-edits.text_6135d4159e");
  return { note: $t("lib.permission-command-edits.text_3b0593ccc1", { "action": action, "value2": edit.subject === "groups" ? $t("lib.permission-command-edits.text_0df737cb62") : $t("lib.permission-command-edits.text_0d0e1a86b3"), "id": edit.id, "restartNote": restartNote }), changed };
}
