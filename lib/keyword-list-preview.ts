import { isVerifiedRaster } from "./file-to-url.ts";
import type { MessageReply, MessageSegment } from "./messages.ts";

const keyToken = /\{(?:image[:_]*([a-fA-F0-9]{32})|face[:_](\d{1,6})|at:([1-9]\d{4,14}))\}/gu;
const maxImages = 4;
const maxMembers = 12;
const maxTokens = 32;
const maxImageBytes = 1024 * 1024;
const previewTimeoutMs = 4_000;

type Part = string | MessageSegment;

export async function previewKeywordList(body: string, {
  group, connection, readMember, readMedia,
}: {
  group?: number;
  connection?: AbortSignal;
  readMember?: (group: number, id: number, signal: AbortSignal) => Promise<string | undefined>;
  readMedia: (url: string, signal: AbortSignal, maxBytes: number) => Promise<Uint8Array | undefined>;
}): Promise<MessageReply> {
  const tokens = [...body.matchAll(keyToken).take(maxTokens)];
  if (!tokens.length || connection?.aborted) return body;
  const timeout = AbortSignal.timeout(previewTimeoutMs);
  const active = connection ? AbortSignal.any([connection, timeout]) : timeout;
  const members = new Map<number, Promise<string | undefined>>();
  const images = new Map<string, Promise<Uint8Array | undefined>>();
  let imageCount = 0;

  const replacements = await Promise.all(tokens.map(async ([raw, image, face, mention]): Promise<Part> => {
    if (image && imageCount < maxImages) {
      imageCount++;
      const id = image.toUpperCase();
      if (!images.has(id)) {
        const url = `https://gchat.qpic.cn/gchatpic_new/0/0-0-${id}/0`;
        images.set(id, readMedia(url, active, maxImageBytes).then(async bytes =>
          bytes && bytes.byteLength <= maxImageBytes && await isVerifiedRaster(bytes, 4_194_304, 4096) ? bytes : undefined)
          .catch(() => undefined));
      }
      const bytes = await images.get(id);
      return bytes && !active.aborted ? { type: "image", file: bytes } : raw;
    }
    if (face) return { type: "face", id: Number(face) };
    if (mention && group !== undefined && readMember) {
      const id = Number(mention);
      if (!members.has(id) && members.size < maxMembers) {
        members.set(id, readMember(group, id, active).catch(() => undefined));
      }
      const name = await members.get(id);
      const shown = name?.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim();
      if (shown && shown.length <= 256 && !active.aborted) return `@${shown}`;
    }
    return raw;
  }));

  if (replacements.every((replacement, index) => replacement === tokens[index]![0])) return body;
  const result: Part[] = [];
  let offset = 0;
  for (const [index, token] of tokens.entries()) {
    if (token.index > offset) result.push(body.slice(offset, token.index));
    result.push(replacements[index]!);
    offset = token.index + token[0].length;
  }
  if (offset < body.length) result.push(body.slice(offset));
  return result;
}
