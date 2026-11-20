import { readQqMessageSegmentMedia } from "./chat-files.ts";
import type { InboundSegment, MessageEvent } from "./messages.ts";

interface Box {
  readonly name: string;
  readonly content: number;
  readonly end: number;
}

const compatibleBrands = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V "]);
const sampleTypes = new Set(["avc1", "avc3", "hvc1", "hev1"]);

function fourCc(data: DataView, at: number) {
  return String.fromCharCode(data.getUint8(at), data.getUint8(at + 1), data.getUint8(at + 2), data.getUint8(at + 3));
}

function boxes(data: DataView, start: number, end: number): Box[] | undefined {
  const result: Box[] = [];
  while (start < end) {
    if (end - start < 8 || result.length >= 1024) return;
    const name = fourCc(data, start + 4);
    let size = data.getUint32(start);
    let header = 8;
    if (size === 1) {
      if (end - start < 16 || data.getUint32(start + 8) !== 0) return;
      size = data.getUint32(start + 12);
      header = 16;
    } else if (size === 0) {
      size = end - start;
    }
    if (size < header || size > end - start) return;
    result.push({ name, content: start + header, end: start + size });
    start += size;
  }
  return result;
}

function child(data: DataView, box: Box, name: string) {
  return boxes(data, box.content, box.end)?.find(value => value.name === name);
}

function supportedVideoTrack(data: DataView, track: Box) {
  if (track.name !== "trak") return false;
  const media = child(data, track, "mdia");
  if (!media) return false;
  const handler = child(data, media, "hdlr");
  if (!handler || handler.end - handler.content < 12 || fourCc(data, handler.content + 8) !== "vide") return false;
  const info = child(data, media, "minf");
  const table = info && child(data, info, "stbl");
  const descriptions = table && child(data, table, "stsd");
  if (!descriptions || descriptions.end - descriptions.content < 8) return false;
  const entries = boxes(data, descriptions.content + 8, descriptions.end);
  return entries?.length === data.getUint32(descriptions.content + 4) && entries.some(entry =>
    sampleTypes.has(entry.name) && entry.end - entry.content >= 78 &&
    data.getUint16(entry.content + 24) > 0 && data.getUint16(entry.content + 26) > 0);
}

export function hasMp4VideoTrack(bytes: Uint8Array): boolean {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const root = boxes(data, 0, bytes.byteLength);
  const format = root?.[0];
  const movie = root?.find(box => box.name === "moov");
  if (format?.name !== "ftyp" || format.end - format.content < 8 || !movie ||
      !root?.some(box => box.name === "mdat" && box.content < box.end)) return false;
  let brandMatch = compatibleBrands.has(fourCc(data, format.content));
  for (let at = format.content + 8; at + 4 <= format.end && at < format.content + 256; at += 4) {
    brandMatch ||= compatibleBrands.has(fourCc(data, at));
  }
  if (!brandMatch) return false;
  return boxes(data, movie.content, movie.end)?.some(track => supportedVideoTrack(data, track)) === true;
}

export function standaloneVideoPart(message: MessageEvent["message"]): InboundSegment | undefined {
  if (typeof message !== "string" && message.length === 1 && message[0]?.type === "video") return message[0];
}

export async function readOriginalQqVideo(part: InboundSegment, signal: AbortSignal): Promise<Uint8Array | undefined> {
  if (part.type !== "video" || signal.aborted) return;
  const bytes = await readQqMessageSegmentMedia(part, signal);
  if (bytes && !signal.aborted && hasMp4VideoTrack(bytes)) return bytes;
}
