import { nativeImageRasterScale } from "@lotus-yunzai/skia";
import { renderStatusCard } from "@lotus-yunzai/skia/status-card";
import type { CommandModule } from "./commands.ts";
import { groupExportSession, groupMemberCsv } from "./group-member-export.ts";
import { segment } from "./messages.ts";
import { accountScopePermission } from "./permissions.ts";

interface GroupMemberExportOptions {
  readonly readConfig: () => Promise<Record<string, unknown>>;
  readonly isMaster: (bot: number, user: number) => boolean;
  readonly activeSignal: (connection: AbortSignal) => AbortSignal;
  readonly render?: (...args: Parameters<typeof renderStatusCard>) => Promise<{ readonly png: Uint8Array }>;
}

const denied = "当前会话没有群成员导出权限。";
const unavailable = "无法读取完整的群成员列表。请确认机器人仍在目标群内。";

export function groupMemberExportCommands({ readConfig, isMaster, activeSignal, render = renderStatusCard }: GroupMemberExportOptions): CommandModule {
  return {
    name: "@lotus-yunzai/group-member-export",
    commands: {},
    async fallback(_message, context) {
      const match = /^#群成员(?:\s*(\d{1,16}))?$/u.exec(context.normalizedMessage);
      if (!match) return;
      const { self_id: bot, user_id: user, message_type, group_id: origin, uploadFile, [groupExportSession]: read } = context;
      const groupMessage = message_type === "group";
      const connection = groupMessage ? context.groupActivitySignal : context.privateCredentialSignal;
      if (context.isDelegated || bot === undefined || user === undefined || !connection || !read) return denied;
      const signal = activeSignal(connection);
      if (signal.aborted) return [];
      const group = match[1] === undefined ? origin : Number(match[1]);
      if (group === undefined || !Number.isSafeInteger(group) || group < 1) return "请使用 #群成员 <群号>，或在目标群直接发送 #群成员。";
      if (groupMessage && origin !== group) return "请在目标群发送 #群成员，或在好友私聊中指定群号。";

      async function permitted() {
        if (signal.aborted) return false;
        const config = await readConfig().catch(() => undefined);
        return !signal.aborted && !!config && accountScopePermission(config, "group.members.export")({
          user_id: user, group_id: group, isMaster: isMaster(bot!, user!),
        });
      }

      if (!await permitted()) return signal.aborted ? [] : denied;
      if (!uploadFile) return "当前协议端不支持发送群成员 CSV。";
      const members = await read(group, signal).catch(() => undefined);
      if (signal.aborted) return [];
      if (!members?.some(row => row.id === bot) ||
          ((groupMessage || !isMaster(bot, user)) && !members.some(row => row.id === user))) return unavailable;
      const file = { name: `${group}.csv`, bytes: groupMemberCsv(members) };
      if (!await permitted() || (!isMaster(bot, user) && !members.some(row => row.id === user))) return signal.aborted ? [] : denied;

      const sent = await uploadFile(file).catch(() => "unknown");
      if (signal.aborted) return [];
      if (sent !== "confirmed") return sent === "rejected"
        ? "群成员 CSV 未发送，请检查文件上传权限。"
        : "群成员 CSV 发送结果未确认，请在当前会话核对。";

      const title = "群成员导出";
      const note = "CSV 已发送。";
      const rows = [`群号　${group}`, `成员数　${members.length}`];
      try {
        const at = new Date();
        const scale = nativeImageRasterScale();
        const limit = context.inlineImageByteLimit ?? Infinity;
        const options = { timeZone: "Asia/Shanghai", scale };
        let card = await render(title, note, rows, at, options);
        if (!signal.aborted && card.png.byteLength > limit && scale === 4) {
          card = await render(title, note, rows, at, { ...options, scale: 2 });
        }
        if (card.png.byteLength <= limit && await permitted()) return segment.image(card.png);
      } catch {
        // The attachment already has a confirmed receipt. The summary can fall back to text.
      }
      return signal.aborted ? [] : await permitted() ? [title, note, ...rows].join("\n") : denied;
    },
  };
}
