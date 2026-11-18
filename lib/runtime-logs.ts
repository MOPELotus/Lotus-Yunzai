import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

type LogKind = "runtime" | "error";
type Query = { readonly limit: number; readonly search?: string };

const maxTailBytes = 4 * 1024 * 1024;
const maxLineLength = 2_000;
const hidden = "[已隐藏]";
const headers = "(?:cookie|set[-_]?cookie|(?:proxy[-_]?)?authorization)";
const secrets = "(?:access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|csrf[-_]?token|cookie[-_]?token|" +
  "stoken[-_]?cookie|[sl]token|token|auth[-_]?key|api[-_]?key|x[-_]?server[-_]?key|password|passwd|passphrase|" +
  "client[-_]?secret|secret|login[-_]?ticket|service[-_]?token|_mhyuuid|密码|令牌|凭据|验证码)(?:[_-]?v?\\d+)?";
// Consume escaped bytes and, if the final quote is missing, the rest of the field.
const quotedValue = String.raw`(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?)`;
const hiddenValue = String.raw`\[已隐藏\]`;
const assignment = String.raw`["']?\s*(?:[:=]|%3[ad])\s*`;
const boundary = String.raw`(^|[^a-z0-9_-])`;
const headerField = new RegExp(`${boundary}(["']?${headers}${assignment})(?:${hiddenValue}|${quotedValue}|.*)`, "giu");
const secretField = new RegExp(`${boundary}(["']?${secrets}${assignment})(?:${hiddenValue}|${quotedValue}|[\\[{].*|[^,;&}\\]#]*)`, "giu");
const secretArgument = new RegExp(`${boundary}(--${secrets}\\s+)(?:${hiddenValue}|${quotedValue}|[^\\s,;]+)`, "giu");

export function runtimeLogFilename(kind: LogKind, now: Date): string {
  if (kind === "error") return "error.log";
  if (!Number.isFinite(now.getTime())) throw new Error("运行日志日期无效。");
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `command.${year}-${month}-${day}.log`;
}

export function sanitizeRuntimeLog(line: string, maxLength = maxLineLength): string {
  const clean = stripVTControlCharacters(line)
    .replace(/[\r\n\t\u2028\u2029]/gu, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, "")
    .replace(headerField, `$1$2${hidden}`)
    .replace(secretField, `$1$2${hidden}`)
    .replace(secretArgument, `$1$2${hidden}`)
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9+/_=.~-]+/giu, (credential) => `${credential.split(/\s/u, 1)[0]} ${hidden}`)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, `$1${hidden}@`);
  const limit = Number.isFinite(maxLength) ? Math.floor(maxLength) : maxLineLength;
  if (limit < 1) return "";
  if (clean.length <= limit) return clean;
  const end = limit - 1;
  const cutoff = end > 0 && /[\ud800-\udbff]/u.test(clean[end - 1]!) ? end - 1 : end;
  return `${clean.slice(0, cutoff)}…`;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function inside(directory: string, target: string): boolean {
  const path = relative(directory, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function loadTail(root: URL, filename: string) {
  try {
    const host = await realpath(fileURLToPath(root));
    const directory = await realpath(join(host, "logs"));
    if (!inside(host, directory)) throw new Error();
    const target = await realpath(join(directory, filename));
    if (!inside(directory, target)) throw new Error();

    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const identity = await file.stat();
      if (!identity.isFile() || !Number.isSafeInteger(identity.size)) throw new Error();
      const checked = await realpath(target);
      if (!inside(directory, checked)) throw new Error();
      const current = await stat(checked);
      if (identity.dev !== current.dev || identity.ino !== current.ino) throw new Error();

      const offset = Math.max(0, identity.size - maxTailBytes);
      const buffer = Buffer.allocUnsafe(identity.size - offset);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, offset + length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      return { bytes: buffer.subarray(0, length), offset, complete: length === buffer.length && (await file.stat()).size === identity.size };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (missing(error)) return;
    throw new Error("无法安全读取运行日志。");
  }
}

export async function readRuntimeLogs(root: URL, kind: LogKind, query: Query, now = new Date()): Promise<readonly string[]> {
  const limit = Number.isFinite(query.limit) ? Math.min(1_000, Math.floor(query.limit)) : 0;
  if (limit < 1) return [];
  const tail = await loadTail(root, runtimeLogFilename(kind, now));
  if (!tail) return [];

  const lines: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const first = tail.offset > 0 ? tail.bytes.indexOf(0x0a) + 1 : 0;
  if (tail.offset > 0 && first === 0) return [];
  let end = tail.complete ? tail.bytes.length : tail.bytes.lastIndexOf(0x0a);
  while (end >= first && lines.length < limit) {
    const start = end > first ? Math.max(first, tail.bytes.lastIndexOf(0x0a, end - 1) + 1) : first;
    try {
      const line = sanitizeRuntimeLog(decoder.decode(tail.bytes.subarray(start, end))).trim();
      if (line && (query.search === undefined || line.includes(query.search))) lines.push(line);
    } catch {
      // An invalid UTF-8 line could also have a damaged credential label.
    }
    end = start - 1;
  }
  return lines;
}
