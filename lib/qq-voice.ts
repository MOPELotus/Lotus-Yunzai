import { readQqMessageMedia, readQqMessageSegmentMedia } from "./chat-files.ts";
import type { InboundSegment } from "./messages.ts";

const silkHeader = new TextEncoder().encode("#!SILK_V3");
const maxSilkPacket = 1024 * 5;

export function hasSilkVoicePackets(bytes: Uint8Array): boolean {
  let offset = bytes[0] === 2 ? 1 : 0;
  if (!silkHeader.every((value, index) => bytes[offset + index] === value)) return false;
  offset += silkHeader.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let hasAudio = false;
  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) return false;
    const size = view.getInt16(offset, true);
    offset += 2;
    if (size === -1) return hasAudio && offset === bytes.length;
    if (size < 0 || size > maxSilkPacket || offset + size > bytes.length) return false;
    hasAudio ||= size > 0;
    offset += size;
  }
  return hasAudio;
}

export async function readOriginalQqVoice(part: InboundSegment, signal: AbortSignal): Promise<Uint8Array | undefined> {
  if (part.type !== "record" || signal.aborted) return;
  let bytes = await readQqMessageSegmentMedia(part, signal).catch(() => undefined);
  const renew = part.getDownloadUrl;
  if (!bytes && !signal.aborted && typeof part.url === "string" && typeof renew === "function") {
    try {
      const fresh = await renew();
      if (typeof fresh === "string" && fresh !== part.url) bytes = await readQqMessageMedia(fresh, signal);
    } catch { return; }
  }
  if (bytes && !signal.aborted && hasSilkVoicePackets(bytes)) return bytes;
}
