import { nativeImageRasterScale } from "@lotus-yunzai/skia";
import { renderStatusCard } from "@lotus-yunzai/skia/status-card";
import { accountScopePolicies } from "./account-scope-policy.ts";
import type { CommandModule, MessageFallbackContext } from "./commands.ts";
import type { GlobalPermissionList } from "./global-permission-policy.ts";
import { segment } from "./messages.ts";
import { readGlobalPermissions } from "./panel-global-permissions.ts";

interface PermissionCommandOptions {
  readonly root: URL;
  readonly terminalOwner: () => boolean;
  readonly activeSignal: (connection?: AbortSignal) => AbortSignal;
  readonly render?: (...args: Parameters<typeof renderStatusCard>) => Promise<{ readonly png: Uint8Array }>;
}

const title = "权限配置";
const description = "查看\n当前权限配置如下。";
const denied = "只有机器人主人可以查看或修改业务权限。";
const listPattern = /^#(?:权限(?:列表|名单|配置)|签到[黑白]名单列表)$/u;
const labels: Record<GlobalPermissionList, string> = {
  "users.allow": "用户白名单", "users.deny": "用户黑名单", "groups.allow": "群白名单", "groups.deny": "群黑名单",
};

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
}

function summarize(ids: readonly string[]) {
  if (!ids.length) return "空";
  const shown = ids.slice(0, 8).join("、");
  return shown + (ids.length > 8 ? ` 等 ${ids.length} 项` : "");
}

export function permissionCommands({ root, terminalOwner, activeSignal, render = renderStatusCard }: PermissionCommandOptions): CommandModule {
  function authorization(context: MessageFallbackContext) {
    if (context.isDelegated || context.canManagePackages !== true) return;
    if (context.message_type === "terminal") return { signal: activeSignal(), allowed: terminalOwner };
    const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal;
    const { user_id: user } = context;
    if (!connection || user === undefined) return;
    return { signal: activeSignal(connection), allowed: () => context.isBotMaster(user) };
  }

  return {
    name: "@lotus-yunzai/permissions",
    commands: {},
    async fallback(_message, context) {
      if (!listPattern.test(context.normalizedMessage)) return;
      const access = authorization(context);
      if (!access || !access.allowed()) return denied;
      const { signal, allowed } = access;
      if (signal.aborted) return [];
      try {
        const { current: { settings }, effective } = await readGlobalPermissions(root);
        if (signal.aborted || !allowed()) return [];
        const scopes = record(record(effective.permissions)?.scopes) ?? {};
        const configured = Object.entries(scopes).flatMap(([scope, entry]) => {
          if (!/^[a-z][\w.-]{0,63}$/u.test(scope)) return [];
          const value = accountScopePolicies.find(policy => policy === record(entry)?.policy) ?? "inherit";
          return [`${scope}:${value}`];
        });
        const shownScopes = configured.slice(0, 12).join(" / ") + (configured.length > 12 ? ` 等 ${configured.length} 项` : "");
        const rows = [
          `默认策略　${settings.default_policy}`,
          ...Object.entries(labels).map(([field, label]) => `${label}　${summarize(settings[field as GlobalPermissionList])}`),
          `作用域　${shownScopes || "未配置"}`,
        ];
        if (context.message_type !== "terminal") {
          try {
            const at = new Date(), scale = nativeImageRasterScale();
            const limit = context.inlineImageByteLimit ?? Infinity;
            const options = { scale, timeZone: "Asia/Shanghai" };
            let card = await render(title, description, rows, at, options);
            if (card.png.byteLength > limit && scale === 4 && !signal.aborted && allowed()) {
              card = await render(title, description, rows, at, { ...options, scale: 2 });
            }
            if (signal.aborted || !allowed()) return [];
            if (card.png.byteLength <= limit) return segment.image(card.png);
          } catch {
            // The same authorized snapshot is available as text when rendering is unavailable.
          }
        }
        return signal.aborted || !allowed() ? [] : [title, description, ...rows].join("\n");
      } catch {
        return signal.aborted || !allowed() ? [] : "暂时无法读取业务权限配置。";
      }
    },
  };
}
