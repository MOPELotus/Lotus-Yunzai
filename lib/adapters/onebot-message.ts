import { Buffer } from "node:buffer";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { generatedImagePreview, type InboundSegment, type MessageReply, type MusicCard } from "../messages.ts";

interface OutboundSegment {
  type: string;
  data: Record<string, string | number>;
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

  const data: OutboundSegment["data"] = { [key]: payload };
  for (const [name, input] of Object.entries(fields)) {
    if (name === key || (fields === value && name === "type")) continue;
    if (type === "image" && name === "sub_type" && typeof input === "number" &&
        Number.isInteger(input) && input >= 0 && input <= 7) {
      data[name] = input;
      continue;
    }
    const result = field(input, name);
    if (result !== undefined) data[name] = result;
  }
  if (type === "image") {
    const preview = generatedImagePreview(parameter, fields);
    if (preview !== undefined) data.summary = preview;
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

export function encodeOneBotForward(nodes: readonly MessageReply[], selfId: number, senderName = "Lotus-Yunzai") {
  const messages = [];
  for (const node of nodes) {
    const content = encodeOneBotReply(typeof node === "string" ? [node] : node);
    if (!Array.isArray(content)) return;
    messages.push({ type: "node", data: { uin: String(selfId), name: senderName, content } });
  }
  if (messages.length) return messages;
}

function musicUrl(value: unknown, page = false): URL | undefined {
  if (typeof value !== "string" || value.length > 8192) return;
  const url = URL.parse(value);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port || (!page && url.hash) ||
      !url.hostname.includes(".") || isIP(url.hostname) || /(?:^|\.)(?:localhost|local|internal|test)$/iu.test(url.hostname)) return;
  return url;
}

export function encodeOneBotMusicCard(card: MusicCard): OutboundSegment[] | undefined {
  if (!isRecord(card)) return;
  const { type, title, content, singer } = card;
  if (!["163", "qq", "kugou", "kuwo", "migu"].some(platform => type === platform) ||
      ![title, content, singer].every(value => typeof value === "string" && value.trim() && value.length <= 256 &&
        !/[\u0000-\u001f\u007f]/u.test(value))) return;
  const url = musicUrl(card.url, true);
  const audio = musicUrl(card.audio);
  const image = musicUrl(card.image);
  if (!url || !audio || !image) return;
  return [{ type: "music", data: { type, url: url.href, audio: audio.href, image: image.href, title, content, singer } }];
}

function unescapeCQ(value: string, parameter = false): string {
  const text = value.replaceAll("&#91;", "[").replaceAll("&#93;", "]");
  return (parameter ? text.replaceAll("&#44;", ",") : text).replaceAll("&amp;", "&");
}

function cqParameters(input: string): Record<string, string> | undefined {
  const fields = new Map<string, string>();
  for (const part of input.split(",")) {
    const separator = part.indexOf("=");
    const name = part.slice(0, separator);
    if (separator < 1 || !/^[A-Za-z0-9_-]+$/u.test(name) || fields.has(name)) return;
    fields.set(name, unescapeCQ(part.slice(separator + 1), true));
  }
  return Object.fromEntries(fields);
}

function parseCQ(input: string): (string | OutboundSegment)[] {
  const parts: (string | OutboundSegment)[] = [];
  let offset = 0;
  for (const match of input.matchAll(/\[CQ:([A-Za-z0-9_-]+)(?:,([^\[\]]*))?\]/gu)) {
    const [source, type, parameters] = match;
    const data = parameters === undefined ? {} : cqParameters(parameters);
    if (!type || !data) continue;
    const key = required.get(type);
    if (key && (type === "text" || type === "at" || type === "reply") && !Object.hasOwn(data, key)) continue;

    if (match.index > offset) parts.push(unescapeCQ(input.slice(offset, match.index)));
    parts.push({ type, data });
    offset = match.index + source.length;
  }
  if (offset < input.length || parts.length === 0) parts.push(unescapeCQ(input.slice(offset)));
  return parts;
}

export function decodeOneBotMessage(value: unknown, selfId?: number) {
  if (typeof value !== "string" && !Array.isArray(value)) return;

  const input: readonly unknown[] = typeof value === "string" ? parseCQ(value) : value;
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
