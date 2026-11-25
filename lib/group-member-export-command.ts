import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
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

const denied = $t("lib.group-member-export-command.text_5a79b5551b");
const unavailable = $t("lib.group-member-export-command.text_6e477cf38a");

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
      if (group === undefined || !Number.isSafeInteger(group) || group < 1) return $t("lib.group-member-export-command.text_846a40616b");
      if (groupMessage && origin !== group) return $t("lib.group-member-export-command.text_2d1f53bc01");

      async function permitted() {
        if (signal.aborted) return false;
        const config = await readConfig().catch(() => undefined);
        return !signal.aborted && !!config && accountScopePermission(config, "group.members.export")({
          user_id: user, group_id: group, isMaster: isMaster(bot!, user!),
        });
      }

      if (!await permitted()) return signal.aborted ? [] : denied;
      if (!uploadFile) return $t("lib.group-member-export-command.text_1321c429c7");
      const members = await read(group, signal).catch(() => undefined);
      if (signal.aborted) return [];
      if (!members?.some(row => row.id === bot) ||
          ((groupMessage || !isMaster(bot, user)) && !members.some(row => row.id === user))) return unavailable;
      const file = { name: `${group}.csv`, bytes: groupMemberCsv(members) };
      if (!await permitted() || (!isMaster(bot, user) && !members.some(row => row.id === user))) return signal.aborted ? [] : denied;

      const sent = await uploadFile(file).catch(() => "unknown");
      if (signal.aborted) return [];
      if (sent !== "confirmed") return sent === "rejected"
        ? $t("lib.group-member-export-command.text_dc1e64841f")
        : $t("lib.group-member-export-command.text_1a580baa39");

      const title = $t("lib.group-member-export-command.text_6f95e2fc92");
      const note = $t("lib.group-member-export-command.text_15950fc552");
      const rows = [$t("lib.group-member-export-command.text_17f18095f3", { "group": group }), $t("lib.group-member-export-command.text_2fa4d4ffc0", { "length": members.length })];
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
