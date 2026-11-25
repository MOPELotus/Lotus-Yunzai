import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
export const groupExportSession = Symbol("groupExportSession");

export interface ExportedGroupMember {
  readonly id: number;
  readonly name: string;
  readonly gender: string;
  readonly title: string;
  readonly role: "member" | "admin" | "owner";
}

export type GroupExportSession = (
  groupId: number, signal: AbortSignal,
) => Promise<readonly ExportedGroupMember[] | undefined>;

export function readExportedGroupMembers(value: unknown, group: number): readonly ExportedGroupMember[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 10_000) return;
  const seen = new Set<number>();
  const members: ExportedGroupMember[] = [];
  const display = (value: unknown) => typeof value === "string" && value.trim()
    ? value.replace(/[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f]/gu, "").slice(0, 512).toWellFormed() || undefined
    : undefined;
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const { group_id, user_id, sex, role, nickname, card, title, special_title } = entry as Record<string, unknown>;
    if (group_id !== group || typeof user_id !== "number" || !Number.isSafeInteger(user_id) || user_id < 1 ||
        seen.has(user_id) || (role !== "member" && role !== "admin" && role !== "owner")) return;
    seen.add(user_id);
    members.push({
      id: user_id, role, name: display(card) ?? display(nickname) ?? $t("lib.group-member-export.text_9d8692671d"),
      gender: sex === "male" ? $t("lib.group-member-export.text_4e79758a99") : sex === "female" ? $t("lib.group-member-export.text_0ab4610b92") : $t("lib.group-member-export.text_4d8c1c5b42"),
      title: display(title) ?? display(special_title) ?? $t("lib.group-member-export.text_484d556139"),
    });
  }
  return members;
}

export function groupMemberCsv(members: readonly ExportedGroupMember[]) {
  const rows = [[$t("lib.group-member-export.text_242918012c"), $t("lib.group-member-export.text_aaee6e4e0b"), $t("lib.group-member-export.text_a752a7d8c1"), $t("lib.group-member-export.text_44a94721f5"), $t("lib.group-member-export.text_e9462d2c96"), $t("lib.group-member-export.text_dbcbe11e0d")]];
  for (const { id, name, gender, title, role } of members) {
    rows.push([String(id), name, gender, title, role === "admin" ? $t("lib.group-member-export.text_b5141d3d19") : $t("lib.group-member-export.text_0c70665b6e"), role === "owner" ? $t("lib.group-member-export.text_b5141d3d19") : $t("lib.group-member-export.text_0c70665b6e")]);
  }
  const cell = (value: string) => {
    const safe = /^[\s\p{Cf}]*[=+@＝＋＠－\-]|^[\t\r\n]/u.test(value) ? "'" + value : value;
    return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };
  return Buffer.from("\ufeff" + rows.map(row => row.map(cell).join(",")).join("\r\n"), "utf8");
}
