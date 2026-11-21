import { delegationSession } from "./command-delegation.ts";
import type { CommandReply } from "./commands.ts";
import type { MessageEvent, MessageReply, ProtocolSegment } from "./messages.ts";

export function isQqFaceCommand(text: string) {
  return /^#取face(?:\s|$)/u.test(text);
}

function faceId(value: unknown): number | undefined {
  const id = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) return id;
}

export function qqFaceReply(event: MessageEvent): CommandReply | undefined {
  if (event.isDelegated || event[delegationSession]?.signal.aborted !== false ||
      (event.message_type !== "group" && (event.message_type !== "private" || event.sub_type !== "friend"))) return;
  const seen = new Set<number>();
  const nodes: MessageReply[] = [];
  for (const part of typeof event.message === "string" ? [] : event.message) {
    if (part.type !== "face") continue;
    const id = faceId(part.id);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);

    const value = part.is_large;
    const isLarge = typeof value === "boolean" ? value
      : value === "1" || value === 1 ? true : value === "0" || value === 0 ? false : undefined;
    const face: ProtocolSegment = { type: "face", data: { id, ...(isLarge === undefined ? {} : { is_large: isLarge }) } };
    const supplied = typeof part.text === "string" ? part.text.trim() : undefined;
    const description = supplied && supplied.length <= 80 && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u.test(supplied)
      ? supplied : "未提供";
    nodes.push(["表情：", face, `\nid：${id}\n描述：${description}`]);
  }

  const [first] = nodes;
  if (!first) return { type: "quoted", message: "❎ 表情参数不可为空" };
  if (nodes.length === 1) return first;
  return { type: "forward", nodes, batchSize: 25, senderName: "Lotus-Yunzai" };
}
