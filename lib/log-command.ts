import { isMilkyOwnerSession } from "./command-permissions.ts";
import type { MessageEvent } from "./messages.ts";
import { replyWithLog } from "./log-reply.ts";

type LogKind = "runtime" | "error";
interface LogQuery {
  readonly limit: number;
  readonly search?: string;
}
type ReadLogs = (kind: LogKind, query: LogQuery) => Promise<readonly string[]>;

const command = /^#(运行日志|错误日志|日志)/u;
const defaultLimit = 100;
const maxLimit = 1000;

export function isLogCommand(message: string): boolean {
  return command.test(message.trim());
}

export function canReadRuntimeLogs(event: MessageEvent): boolean {
  if (event.adapter === "milky") return event.message_type === "private" && isMilkyOwnerSession(event);
  return event.isMaster === true && (event.message_type === "terminal" ||
    (event.message_type === "private" && event.boundAccount === true));
}

function parseQuery(argument: string): LogQuery | undefined {
  const amount = /^(\d+)(?:\s+|$)/u.exec(argument);
  if (!amount) return argument ? { limit: maxLimit, search: argument } : { limit: defaultLimit };

  const limit = Math.min(Number(amount[1]), maxLimit);
  if (limit === 0) return;
  const search = argument.slice(amount[0].length);
  return search ? { limit, search } : { limit };
}

export function createLogCommand(readLogs: ReadLogs) {
  return async (event: MessageEvent): Promise<boolean> => {
    const message = event.msg.trim();
    const match = command.exec(message);
    if (!match) return false;

    if (!canReadRuntimeLogs(event)) return true;

    const query = parseQuery(message.slice(match[0].length).trim());
    if (!query) {
      await event.reply("日志条数须大于 0，最多显示 1000 条。");
      return true;
    }

    const error = match[1] === "错误日志";
    const label = error ? "错误日志" : "运行日志";
    let lines: readonly string[];
    try {
      lines = await readLogs(error ? "error" : "runtime", query);
    } catch {
      await event.reply("读取日志失败，请稍后重试。");
      return true;
    }
    if (!lines.length) {
      await event.reply(`暂无相关${label}。`);
      return true;
    }

    const title = `最近 ${Math.min(lines.length, query.limit)} 条${label}`;
    await replyWithLog(event, title, lines, { limit: query.limit });
    return true;
  };
}
