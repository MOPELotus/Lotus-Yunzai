import type { MessageEvent } from "./messages.ts";

const nodeBytes = 1200;
const maxBodyNodes = 98;
const maxForwardBytes = 96 * 1024;
const maxChatTextBytes = 3000;
const maxTerminalTextBytes = 96 * 1024;
const clippedNotice = "日志内容过长，已截取部分内容。";

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

function collect(lines: readonly string[], limit: number, budget: number, separator: string) {
  const output: string[] = [];
  const separatorBytes = Buffer.byteLength(separator);
  for (const line of lines.slice(0, limit)) {
    if (output.length) budget -= separatorBytes;
    if (budget < 0) return { body: output.join(separator), clipped: true };
    const text = prefix(line, budget);
    output.push(text);
    if (text.length < line.length) return { body: output.join(separator), clipped: true };
    budget -= Buffer.byteLength(text);
  }
  return { body: output.join(separator), clipped: lines.length > limit };
}

function forwardNodes(lines: readonly string[], limit: number, title: string, separator: string): readonly string[] {
  const { body, clipped } = collect(lines, limit, maxForwardBytes, separator);
  const nodes = [title];
  let current = "";
  for (const line of body.split(separator)) {
    const joined = current ? `${current}${separator}${line}` : line;
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

export async function replyWithLog(event: MessageEvent, title: string, lines: readonly string[], {
  limit = lines.length,
  separator = "\n",
  unconfirmed = "日志转发结果未确认，请在聊天中核对。",
}: { readonly limit?: number; readonly separator?: string; readonly unconfirmed?: string } = {}): Promise<void> {
  const terminal = event.message_type === "terminal";
  if (!terminal && event.forward) {
    try {
      if (await event.forward(forwardNodes(lines, limit, title, separator))) return;
    } catch {
      await event.reply(unconfirmed);
      return;
    }
  }

  const maxBytes = terminal ? maxTerminalTextBytes : maxChatTextBytes;
  const budget = maxBytes - Buffer.byteLength(`${title}${separator}\n${clippedNotice}`);
  const { body, clipped } = collect(lines, limit, budget, separator);
  await event.reply(clipped ? `${title}${separator}${body}\n${clippedNotice}` : `${title}${separator}${body}`);
}
