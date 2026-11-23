export const groupExportSession = Symbol("groupExportSession");

export interface ExportedGroupMember {
  readonly id: number;
  readonly name: string;
  readonly gender: "男" | "女" | "未知";
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
      id: user_id, role, name: display(card) ?? display(nickname) ?? "群成员",
      gender: sex === "male" ? "男" : sex === "female" ? "女" : "未知",
      title: display(title) ?? display(special_title) ?? "无",
    });
  }
  return members;
}

export function groupMemberCsv(members: readonly ExportedGroupMember[]) {
  const rows = [["QQ号", "昵称/群名片", "性别", "头衔", "是否管理员", "是否群主"]];
  for (const { id, name, gender, title, role } of members) {
    rows.push([String(id), name, gender, title, role === "admin" ? "是" : "否", role === "owner" ? "是" : "否"]);
  }
  const cell = (value: string) => {
    const safe = /^[\s\p{Cf}]*[=+@＝＋＠－\-]|^[\t\r\n]/u.test(value) ? "'" + value : value;
    return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };
  return Buffer.from("\ufeff" + rows.map(row => row.map(cell).join(",")).join("\r\n"), "utf8");
}
