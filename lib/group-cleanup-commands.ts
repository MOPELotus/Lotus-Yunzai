import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import type { createProfileStore } from "@lotus-yunzai/account";
import { renderStatusCard } from "@lotus-yunzai/skia/status-card";
import { appendPrivateAuditLine } from "./checkin-audit.ts";
import type { CommandModule } from "./commands.ts";
import { groupCleanupConfig } from "./group-cleanup-config.ts";
import { segment } from "./messages.ts";
import { accountScopePermission } from "./permissions.ts";

interface GroupCleanupOptions {
  readonly profiles: Pick<ReturnType<typeof createProfileStore>, "listIds" | "checkinSettings" | "removeGroupCheckinFallback">;
  readonly auditPath: string;
  readonly readConfig: () => Promise<Record<string, unknown>>;
  readonly isMaster: (bot: number, user: number) => boolean;
  readonly activeSignal: (connection: AbortSignal) => AbortSignal;
  readonly render?: typeof renderStatusCard;
}

const command = "#群清理退群";
const title = $t("lib.group-cleanup-commands.text_04ee73e15c");
const args = /^(\d{1,19})(?:\s+(\d{1,16}))?$/u;
const denied = $t("lib.group-cleanup-commands.text_c2cbcdc304");

export function groupCleanupCommands({ profiles, auditPath, readConfig, isMaster, activeSignal, render = renderStatusCard }: GroupCleanupOptions): CommandModule {
  return {
    name: "[group] 退群档案清理",
    commands: {
      async [command](argument, context) {
        const { group_id, user_id, self_id, groupActivityRoster } = context;
        const groupMessage = context.message_type === "group";
        const connection = groupMessage ? context.groupActivitySignal : context.privateCredentialSignal;
        if (context.isDelegated || self_id === undefined || user_id === undefined || !connection) return denied;
        const signal = activeSignal(connection);
        if (signal.aborted) return "";

        async function authorized() {
          if (signal.aborted) return;
          const configured = await readConfig().catch(() => undefined);
          if (!configured || signal.aborted || !accountScopePermission(configured, "group.cleanup")({
            user_id, group_id, isMaster: isMaster(self_id!, user_id!),
          })) return;
          return groupCleanupConfig(configured.groups);
        }

        async function reply(badge: string, message: string, rows: readonly string[] = [], protect = false) {
          const lead = `${badge}\n${message}`;
          const limit = context.inlineImageByteLimit;
          let image: Buffer | undefined;
          try {
            const at = new Date();
            const options = { timeZone: "Asia/Shanghai" };
            let { png } = await render(title, lead, rows, at, options);
            if (limit !== undefined && png.byteLength > limit && !signal.aborted) {
              ({ png } = await render(title, lead, rows, at, { ...options, scale: 2 }));
            }
            if (png.byteLength > 0 && (limit === undefined || png.byteLength <= limit)) image = png;
          } catch {
            // The same authorized summary is available when rendering fails.
          }
          if (protect && !await authorized()) return signal.aborted ? "" : denied;
          if (signal.aborted) return "";
          return image ? segment.image(image) : [title, lead, ...rows].join("\n");
        }

        const settings = await authorized();
        if (!settings) return signal.aborted ? "" : reply($t("lib.group-cleanup-commands.text_136de7a8c4"), denied);
        const match = args.exec(argument.trim());
        const qq = match?.[1];
        const groupId = match?.[2] === undefined ? group_id : Number(match[2]);
        if (!qq || (groupId !== undefined && (!Number.isSafeInteger(groupId) || groupId < 1))) {
          return reply($t("lib.group-cleanup-commands.text_28384d7afd"), $t("lib.group-cleanup-commands.text_78f91f8737"));
        }

        const ids = await profiles.listIds(qq).catch(() => undefined);
        if (!ids) return reply($t("lib.group-cleanup-commands.text_28384d7afd"), $t("lib.group-cleanup-commands.text_08e56ba5cc"));
        const actions: { profileId: number; revision: string; planned: boolean; removed: boolean }[] = [];
        let unreadable = 0;
        for (const profileId of ids) {
          if (!await authorized()) return signal.aborted ? "" : denied;
          const profile = await profiles.checkinSettings(qq, profileId).catch(() => undefined);
          if (!profile) { unreadable++; continue; }
          actions.push({
            profileId, revision: profile.revision,
            planned: settings.removeFallback && groupId !== undefined && profile.notify.fallbackGroups.includes(groupId),
            removed: false,
          });
        }
        if (!await authorized()) return signal.aborted ? "" : denied;
        const planned = actions.filter(action => action.planned);
        const qqNumber = Number(qq);
        const canTry = planned.length > 0 && !settings.dryRun && !settings.archiveRequested && groupMessage && groupId === group_id &&
          groupId !== undefined && Number.isSafeInteger(qqNumber) && qqNumber > 0 && !!groupActivityRoster;
        async function audit(phase?: "plan" | "result") {
          await appendPrivateAuditLine(auditPath, {
            time: new Date().toISOString(), reason: "manual_cleanup", userId: qq,
            groupId: groupId === undefined ? "" : String(groupId), dryRun: !actions.some(action => action.removed),
            actions: actions.map(({ profileId, planned, removed }) => ({
              profileId, plannedFallback: planned, removedFallback: phase === "result" ? removed : planned, archived: false,
            })), unreadable, ...(phase && { phase }),
          });
        }

        try {
          await audit(canTry ? "plan" : undefined);
        } catch {
          return reply($t("lib.group-cleanup-commands.text_28384d7afd"), $t("lib.group-cleanup-commands.text_d47dc1c1c3"));
        }

        if (canTry) {
          async function verify() {
            const roster = !signal.aborted ? await groupActivityRoster?.("member") : undefined;
            const latest = await authorized();
            if (!roster || !roster.some(member => member.userId === self_id) || !roster.some(member => member.userId === user_id) ||
              roster.some(member => member.userId === qqNumber) || !latest || latest.dryRun || !latest.removeFallback ||
              latest.archiveRequested) throw new Error($t("lib.group-cleanup-commands.text_92713e37a1"));
          }

          for (const action of planned) {
            if (!await authorized()) break;
            try {
              const result = await profiles.removeGroupCheckinFallback(qq, action.profileId, action.revision, groupId, signal, verify);
              action.removed = result.changed;
            } catch {
              // The unchanged profile remains in the audit plan and scoped summary.
            }
          }
          try {
            await audit("result");
          } catch {
            const count = actions.filter(action => action.removed).length;
            return reply($t("lib.group-cleanup-commands.text_28384d7afd"), $t("lib.group-cleanup-commands.text_18cab136d0", { "count": count }), [], true);
          }
        }

        const removed = actions.filter(action => action.removed).length;
        const note = settings.archiveRequested ? $t("lib.group-cleanup-commands.text_06fc08ca6f")
          : removed ? $t("lib.group-cleanup-commands.text_9652dbffab")
          : canTry ? $t("lib.group-cleanup-commands.text_4687886b7c")
          : $t("lib.group-cleanup-commands.text_7a7eca527e");
        return reply(removed ? $t("lib.group-cleanup-commands.text_c0b3fbff51") : $t("lib.group-cleanup-commands.text_13d61fea9f"), note, [
          $t("lib.group-cleanup-commands.text_d089566658", { "qq": qq }), $t("lib.group-cleanup-commands.text_8344f202e3", { "value1": groupId ?? $t("lib.group-cleanup-commands.text_4d8c1c5b42") }), $t("lib.group-cleanup-commands.text_7a5bcd0c2d", { "length": ids.length }),
          $t("lib.group-cleanup-commands.text_c98da239de", { "length": planned.length }), ...(removed ? [$t("lib.group-cleanup-commands.text_d830134e0f", { "removed": removed })] : []),
          $t("lib.group-cleanup-commands.text_bafd8576e3"), ...(unreadable ? [$t("lib.group-cleanup-commands.text_9b4888c8af", { "unreadable": unreadable })] : []),
          ...(removed && removed < planned.length ? [$t("lib.group-cleanup-commands.text_d1dd078a20", { "value1": planned.length - removed })] : []),
        ], true);
      },
    },
  };
}
