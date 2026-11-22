import type { MessageEvent, QuotedMessage, RecallResult } from "./messages.ts";
import type { QuotedGroupFileRemoval } from "./adapters/quoted-group-file.ts";

export type GroupRecallRole = "member" | "admin" | "owner";
export const groupRecallPermissionValues = ["all", "admin", "owner", "master"] as const;
type Permission = (typeof groupRecallPermissionValues)[number];
type GroupRecallPermissions = Readonly<{ bot: Permission; member: Permission }>;
const configurationPaths = ["plugins/yenai-plugin/config/config/groupAdmin.yaml", "config/groupAdmin.yaml"];
const permissions = new Set<unknown>(groupRecallPermissionValues);
const commandLimit = 4_096;

export async function readGroupRecallPermissions(root: URL): Promise<GroupRecallPermissions | undefined> {
  const result: { bot: unknown; member: unknown } = { bot: "all", member: "admin" };
  try {
    for (const path of configurationPaths) {
      const file = Bun.file(new URL(path, root));
      if (!await file.exists()) continue;
      if (file.size > 256 * 1024) return;
      const value: unknown = Bun.YAML.parse(await file.text());
      if (value == null) continue;
      if (typeof value !== "object" || Array.isArray(value)) return;
      if (!Object.hasOwn(value, "recallMsgPer")) continue;
      const section = (value as Record<string, unknown>).recallMsgPer;
      if (!section || typeof section !== "object" || Array.isArray(section)) return;
      for (const field of ["bot", "member"] as const) {
        if (Object.hasOwn(section, field)) result[field] = (section as Record<string, unknown>)[field];
      }
    }
    if (permissions.has(result.bot) && permissions.has(result.member)) return result as GroupRecallPermissions;
  } catch {
    return;
  }
}

type Recall = (policy: {
  active(): boolean;
  authorize(isBotMessage: boolean, role: () => Promise<GroupRecallRole | undefined>): Promise<true | string | undefined>;
}) => Promise<readonly RecallResult[] | string | undefined>;

interface QuotedRecall {
  readonly account: number;
  readonly actor: number;
  readonly group?: number;
  readonly run: Recall;
}

export const quotedRecallSessions = new WeakMap<MessageEvent, QuotedRecall>();

export function groupRecallPermission(required: Permission, master: boolean, role: GroupRecallRole | undefined) {
  if (master || (role && (required === "all" || (role === "owner" && required !== "master") ||
      (role === "admin" && required === "admin")))) return true;
  if (required === "master") return "该命令仅限主人可用。";
  if (required === "owner") return "该命令仅限群主可用。";
  if (required === "admin") return "该命令仅限群管理员可用。";
  return "无法核实本群成员身份。";
}

export function createQuotedRecall() {
  const completed = new Set<string>();
  const targets = new Set<string>();
  const activeCommands = new Set<string>();
  const groupFiles = new Set<string>();

  return (scope: {
    readonly account: number;
    readonly actor: number;
    readonly peer: number;
    readonly group: boolean;
    readonly command: number;
    readonly quoted: number;
    readonly signal: AbortSignal;
    readQuote(): Promise<QuotedMessage | undefined>;
    readRole(): Promise<GroupRecallRole | undefined>;
    recall(id: number): Promise<RecallResult>;
    groupFile?(source: QuotedMessage): QuotedGroupFileRemoval | undefined;
  }): QuotedRecall => ({ account: scope.account, actor: scope.actor, group: scope.group ? scope.peer : undefined,
    async run({ active, authorize }) {
      const { account, peer, group, command, quoted, signal } = scope;
      const chat = `${account}:${group ? "group" : "friend"}:${peer}`;
      const commandKey = `${chat}:${command}`;
      const targetKey = `${chat}:${quoted}`;
      const permitted = () => !signal.aborted && active();
      if (!permitted() || completed.has(commandKey) || activeCommands.has(commandKey) || activeCommands.size >= commandLimit) return;
      if (completed.size + activeCommands.size >= commandLimit) completed.delete(completed.values().next().value!);
      if (targets.has(targetKey) || targets.has(commandKey) || activeCommands.has(targetKey)) {
        completed.add(commandKey);
        return;
      }
      activeCommands.add(commandKey);
      targets.add(targetKey);
      try {
        const source = await scope.readQuote();
        if (!permitted()) return;
        if (!source) return "无法核实当前会话的引用消息。";
        const bot = source.user_id === account;
        if (!group && !bot) return;
        const authorized = await authorize(bot, scope.readRole);
        if (authorized !== true) return permitted() ? authorized : undefined;
        if (!permitted()) return;
        if (group && source.message[0]?.type === "file") {
          const file = scope.groupFile?.(source);
          if (!file) return "无法核实引用的群文件。";
          const fileKey = `${chat}:${file.id}`;
          if (groupFiles.has(fileKey)) return;
          groupFiles.add(fileKey);
          try {
            const remove = await file.locate(permitted);
            if (!permitted()) return;
            if (!remove) return "当前群文件目录没有可核实的对应文件。";
            const currentAuthority = await authorize(bot, scope.readRole);
            if (!permitted()) return;
            if (currentAuthority !== true) return currentAuthority;
            const deleted = await remove();
            if (!permitted()) return;
            if (deleted === "unknown") return "群文件删除结果未确认。";
            if (deleted === "rejected") return "未能删除群文件。";
            const cleanup = await scope.recall(command);
            if (permitted() && cleanup !== "confirmed") return "群文件已删除，撤回命令未获确认。";
            return;
          } finally {
            groupFiles.delete(fileKey);
          }
        }
        const target = await scope.recall(quoted);
        if (!permitted()) return;
        if (target !== "confirmed" || !group) return [target];
        return [target, await scope.recall(command)];
      } finally {
        activeCommands.delete(commandKey);
        targets.delete(targetKey);
        // Count the incoming event once even if the authorization or gateway result is uncertain.
        completed.add(commandKey);
      }
    },
  });
}
