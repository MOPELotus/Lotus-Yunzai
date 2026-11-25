import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
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

function canReadRuntimeLogs(event: MessageEvent): boolean {
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
      await event.reply($t("lib.log-command.text_11961a6556"));
      return true;
    }

    const error = match[1] === "错误日志";
    const label = error ? $t("lib.log-command.text_7918957c16") : $t("lib.log-command.text_fc08fa2609");
    let lines: readonly string[];
    try {
      lines = await readLogs(error ? "error" : "runtime", query);
    } catch {
      await event.reply($t("lib.log-command.text_005aa9a804"));
      return true;
    }
    if (!lines.length) {
      await event.reply($t("lib.log-command.text_125add2646", { "label": label }));
      return true;
    }

    const title = $t("lib.log-command.text_3018d63fab", { "value1": Math.min(lines.length, query.limit), "label": label });
    await replyWithLog(event, title, lines, { limit: query.limit });
    return true;
  };
}
