import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { nativeImageRasterScale } from "@lotus-yunzai/skia";
import { renderStatusCard } from "@lotus-yunzai/skia/status-card";
import { accountScopePolicies } from "./account-scope-policy.ts";
import type { CommandModule, MessageFallbackContext } from "./commands.ts";
import type { GlobalPermissionList } from "./global-permission-policy.ts";
import { segment } from "./messages.ts";
import { readGlobalPermissions } from "./panel-global-permissions.ts";
import { editChatPermissions, parsePermissionEdit } from "./permission-command-edits.ts";

interface PermissionCommandOptions {
  readonly root: URL;
  readonly terminalOwner: () => boolean;
  readonly activeSignal: (...connections: AbortSignal[]) => AbortSignal;
  readonly render?: (...args: Parameters<typeof renderStatusCard>) => Promise<{ readonly png: Uint8Array }>;
}

const title = $t("lib.permission-commands.text_2ee4406b48");
const denied = $t("lib.permission-commands.text_3f9649de2c");
const listPattern = /^#(?:权限(?:列表|名单|配置)|签到[黑白]名单列表)$/u;
const labels: Record<GlobalPermissionList, string> = {
  "users.allow": $t("lib.permission-commands.text_8c4715253c"), "users.deny": $t("lib.permission-commands.text_6ae2ab05a0"), "groups.allow": $t("lib.permission-commands.text_f1578eca20"), "groups.deny": $t("lib.permission-commands.text_cd309a726c"),
};

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
}

function summarize(ids: readonly string[]) {
  if (!ids.length) return $t("lib.permission-commands.text_2f8267a89a");
  const shown = ids.slice(0, 8).join("、");
  return shown + (ids.length > 8 ? $t("lib.permission-commands.text_1420097019", { "length": ids.length }) : "");
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
      const list = listPattern.test(context.normalizedMessage);
      const edit = list ? undefined : parsePermissionEdit(context.normalizedMessage);
      if (!list && edit === undefined) return;
      const access = authorization(context);
      if (!access || !access.allowed()) return denied;
      const { signal, allowed } = access;
      if (signal.aborted) return [];
      if (edit === "invalid") return $t("lib.permission-commands.text_480d526e88");
      if (edit === "unsupported") return $t("lib.permission-commands.text_3fe48071de");
      let description = $t("lib.permission-commands.text_f3f9a009b4");
      if (edit) {
        const outcome = await editChatPermissions(root, edit, {
          active: () => !signal.aborted && allowed(), signal, actor: String(context.user_id ?? "stdin"), group: context.group_id,
        });
        if (signal.aborted || !allowed()) return [];
        if (typeof outcome === "string") return outcome;
        description = `${outcome.changed ? $t("lib.permission-commands.text_434203a723") : $t("lib.permission-commands.text_025122f1c5")}
${outcome.note}`;
      }
      try {
        const { current: { settings }, effective } = await readGlobalPermissions(root);
        if (signal.aborted || !allowed()) return [];
        const scopes = record(record(effective.permissions)?.scopes) ?? {};
        const configured = Object.entries(scopes).flatMap(([scope, entry]) => {
          if (!/^[a-z][\w.-]{0,63}$/u.test(scope)) return [];
          const value = accountScopePolicies.find(policy => policy === record(entry)?.policy) ?? "inherit";
          return [`${scope}:${value}`];
        });
        const shownScopes = configured.slice(0, 12).join(" / ") + (configured.length > 12 ? $t("lib.permission-commands.text_1420097019", { "length": configured.length }) : "");
        const rows = [
          $t("lib.permission-commands.text_17854f7ba3", { "default_policy": settings.default_policy }),
          ...Object.entries(labels).map(([field, label]) => `${label}　${summarize(settings[field as GlobalPermissionList])}`),
          $t("lib.permission-commands.text_bb3c736145", { "value1": shownScopes || $t("lib.permission-commands.text_80a57e03f0") }),
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
        return signal.aborted || !allowed() ? [] : $t("lib.permission-commands.text_f1b15f121f");
      }
    },
  };
}
