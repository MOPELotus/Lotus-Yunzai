import type { MessageEvent } from "./messages.ts";

type LogKind = "runtime" | "error";
interface LogQuery {
  readonly limit: number;
  readonly search?: string;
}
type ReadLogs = (kind: LogKind, query: LogQuery) => Promise<readonly string[]>;

const command = /^#(运行日志|错误日志|日志)/u;
const defaultLimit = 100;
const maxLimit = 1000;
const nodeBytes = 1200;
const maxBodyNodes = 98;
const maxForwardBytes = 96 * 1024;
const maxPrivateTextBytes = 3000;
const maxTerminalTextBytes = 96 * 1024;
const clippedNotice = "日志内容过长，已截取部分内容。";

export function isLogCommand(message: string): boolean {
  return command.test(message.trim());
}

function parseQuery(argument: string): LogQuery | undefined {
  const amount = /^(\d+)(?:\s+|$)/u.exec(argument);
  if (!amount) return argument ? { limit: maxLimit, search: argument } : { limit: defaultLimit };

  const limit = Math.min(Number(amount[1]), maxLimit);
  if (limit === 0) return;
  const search = argument.slice(amount[0].length);
  return search ? { limit, search } : { limit };
}

function prefix(text: string, budget: number): string {
  if (Buffer.byteLength(text) <= budget) return text;
  let length = 0;
  for (const character of text) {
    budget -= Buffer.byteLength(character);
    if (budget < 0) break;
    length += character.length;
  }
  return text.slice(0, length);
}

function collect(lines: readonly string[], limit: number, budget: number) {
  const output: string[] = [];
  for (const line of lines.slice(0, limit)) {
    if (output.length) budget--;
    if (budget < 0) return { body: output.join("\n"), clipped: true };
    const text = prefix(line, budget);
    output.push(text);
    if (text.length < line.length) return { body: output.join("\n"), clipped: true };
    budget -= Buffer.byteLength(text);
  }
  return { body: output.join("\n"), clipped: lines.length > limit };
}

function forwardNodes(lines: readonly string[], limit: number, title: string): readonly string[] {
  const { body, clipped } = collect(lines, limit, maxForwardBytes);
  const nodes = [title];
  let current = "";
  for (const line of body.split("\n")) {
    const joined = current ? `${current}\n${line}` : line;
    if (Buffer.byteLength(joined) <= nodeBytes) {
      current = joined;
      continue;
    }

    if (current) nodes.push(current);
    current = line;
    while (nodes.length <= maxBodyNodes) {
      const chunk = prefix(current, nodeBytes);
      if (chunk === current) break;
      nodes.push(chunk);
      current = current.slice(chunk.length);
    }
    if (nodes.length > maxBodyNodes) return [...nodes, clippedNotice];
  }
  if (current) nodes.push(current);
  if (clipped) nodes.push(clippedNotice);
  return nodes;
}

function textReply(lines: readonly string[], limit: number, title: string, maxBytes: number): string {
  const budget = maxBytes - Buffer.byteLength(`${title}\n\n${clippedNotice}`);
  const { body, clipped } = collect(lines, limit, budget);
  return clipped ? `${title}\n${body}\n${clippedNotice}` : `${title}\n${body}`;
}

export function createLogCommand(readLogs: ReadLogs) {
  return async (event: MessageEvent): Promise<boolean> => {
    const message = event.msg.trim();
    const match = command.exec(message);
    if (!match) return false;

    const terminal = event.message_type === "terminal";
    const boundPrivate = event.message_type === "private" && event.boundAccount === true;
    if (event.isMaster !== true || (!terminal && !boundPrivate)) return true;

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
    if (!terminal && event.forward) {
      try {
        if (await event.forward(forwardNodes(lines, query.limit, title))) return true;
      } catch {
        await event.reply("日志转发结果未确认，请在聊天中核对。");
        return true;
      }
    }
    await event.reply(textReply(lines, query.limit, title, terminal ? maxTerminalTextBytes : maxPrivateTextBytes));
    return true;
  };
}
