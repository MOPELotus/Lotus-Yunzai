import { Buffer } from "node:buffer";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { InboundSegment } from "../messages.ts";

interface OutboundSegment {
  type: string;
  data: Record<string, string>;
}

const required = new Map([
  ["text", "text"],
  ["at", "qq"],
  ["face", "id"],
  ["reply", "id"],
  ["image", "file"],
  ["record", "file"],
  ["video", "file"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): string | undefined {
  if (key === "file" && value instanceof Uint8Array && value.byteLength > 0) {
    return `base64://${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64")}`;
  }
  if (typeof value === "string") {
    return key === "file" && isAbsolute(value) ? pathToFileURL(value).href : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
}

function encodeSegment(value: unknown): OutboundSegment | undefined {
  if (typeof value === "string") return { type: "text", data: { text: value } };
  if (!isRecord(value) || typeof value.type !== "string") return;
  const type = value.type;
  const key = required.get(type);
  if (!key) return;

  const fields = isRecord(value.data) ? value.data : value;
  const parameter = fields[key];
  if (key === "text" && typeof parameter !== "string") return;
  if (key === "file" && typeof parameter !== "string" && !(parameter instanceof Uint8Array)) return;
  if ((key === "qq" || key === "id") &&
      typeof parameter !== "string" && !Number.isSafeInteger(parameter)) return;
  const payload = field(parameter, key);
  if (payload === undefined || (payload === "" && key !== "text")) return;

  const data: Record<string, string> = { [key]: payload };
  for (const [name, input] of Object.entries(fields)) {
    if (name === key || (fields === value && name === "type")) continue;
    const result = field(input, name);
    if (result !== undefined) data[name] = result;
  }
  return { type, data };
}

export function encodeOneBotReply(value: unknown, quoteId?: number): string | OutboundSegment[] | undefined {
  if (typeof value === "string" && quoteId === undefined) return value;

  const parts: readonly unknown[] = Array.isArray(value) ? value : [value];
  if (parts.length === 0) return;

  const segments: OutboundSegment[] = [];
  for (const part of parts) {
    const encoded = encodeSegment(part);
    if (!encoded) return;
    segments.push(encoded);
  }

  if (quoteId !== undefined && !segments.some((part) => part.type === "reply")) {
    segments.unshift({ type: "reply", data: { id: String(quoteId) } });
  }
  return segments;
}

export function decodeOneBotMessage(value: unknown, selfId?: number) {
  if (typeof value !== "string" && !Array.isArray(value)) return;

  const input: readonly unknown[] = typeof value === "string" ? [value] : value;
  const message: InboundSegment[] = [];
  const text: string[] = [];
  const img: string[] = [];
  let atBot = false;
  let at: string | number | undefined;
  let replyId: string | number | undefined;

  for (const part of input) {
    if (typeof part === "string") {
      message.push({ type: "text", text: part });
      text.push(part);
      continue;
    }
    if (!isRecord(part) || typeof part.type !== "string" || !isRecord(part.data)) return;

    const { type, data } = part;
    message.push({ ...data, type });
    switch (type) {
      case "text":
        if (typeof data.text !== "string") return;
        text.push(data.text);
        break;
      case "at": {
        const qq = data.qq;
        if (typeof qq !== "string" && typeof qq !== "number") return;
        if (selfId !== undefined && String(qq) === String(selfId)) atBot = true;
        else at = qq;
        break;
      }
      case "reply": {
        const id = data.id;
        if (typeof id !== "string" && typeof id !== "number") return;
        replyId = id;
        break;
      }
      case "image":
        if (typeof data.url === "string") img.push(data.url);
        break;
    }
  }

  return {
    message,
    text: text.join(""),
    atBot,
    at,
    reply_id: replyId,
    img: img.length > 0 ? img : undefined,
  };
}
