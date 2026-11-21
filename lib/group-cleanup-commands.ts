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
const title = "群配置清理";
const args = /^(\d{1,19})(?:\s+(\d{1,16}))?$/u;
const denied = "当前会话没有群配置清理权限。";

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
        if (!settings) return signal.aborted ? "" : reply("拒绝", denied);
        const match = args.exec(argument.trim());
        const qq = match?.[1];
        const groupId = match?.[2] === undefined ? group_id : Number(match[2]);
        if (!qq || (groupId !== undefined && (!Number.isSafeInteger(groupId) || groupId < 1))) {
          return reply("失败", "请使用 #群清理退群 <用户QQ> [群号]。");
        }

        const ids = await profiles.listIds(qq).catch(() => undefined);
        if (!ids) return reply("失败", "暂时无法读取用户档案。");
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
          return reply("失败", "无法写入群配置清理审计记录。");
        }

        if (canTry) {
          async function verify() {
            const roster = !signal.aborted ? await groupActivityRoster?.("member") : undefined;
            const latest = await authorized();
            if (!roster || !roster.some(member => member.userId === self_id) || !roster.some(member => member.userId === user_id) ||
              roster.some(member => member.userId === qqNumber) || !latest || latest.dryRun || !latest.removeFallback ||
              latest.archiveRequested) throw new Error("无法确认群通知回退变更");
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
            return reply("失败", `已移除 ${count} 份群通知回退，结果审计写入失败，操作计划已保留。`, [], true);
          }
        }

        const removed = actions.filter(action => action.removed).length;
        const note = settings.archiveRequested ? "其他群与私聊状态尚未核实，档案归档仅预览。"
          : removed ? "清理结果已写入审计。"
          : canTry ? "未确认目标已离群或档案已变更，保留回退设置。"
          : "已写入清理预览。";
        return reply(removed ? "完成" : "预览", note, [
          `用户　${qq}`, `群　${groupId ?? "未知"}`, `档案　${ids.length}`,
          `拟移除群通知回退　${planned.length}`, ...(removed ? [`已移除群通知回退　${removed}`] : []),
          "归档档案　0", ...(unreadable ? [`无法读取　${unreadable}`] : []),
          ...(removed && removed < planned.length ? [`未确认　${planned.length - removed}`] : []),
        ], true);
      },
    },
  };
}
