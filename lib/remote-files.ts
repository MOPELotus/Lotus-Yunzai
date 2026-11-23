import { constants } from "node:fs";
import { link, open, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { withWindowsRemotePath } from "./remote-win32.ts";
import { isChatFileName, maxChatFileBytes, type ChatFile } from "./chat-files.ts";

function segments(root: string, target: string) {
  const segments = (isAbsolute(target) ? relative(root, target) : target).split(sep);
  const reserved = /^(?:(?:CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$))|[<>:"|?*]|[. ]$/iu;
  if (!segments.every(part => isChatFileName(part) && (process.platform !== "win32" || !reserved.test(part)))) return;
  return segments;
}

async function withFile<T>(root: string, target: string, read: boolean, access: (file: string, name: string) => Promise<T>): Promise<T | undefined> {
  const directory = ["data", "remote", "files"];
  const parts = segments(join(root, ...directory), target);
  if (!parts) return;
  const name = parts.pop()!;
  if (process.platform === "win32") return withWindowsRemotePath(root, [...directory, ...parts], name, read, access);
  if (process.platform !== "linux") return;
  const handles: FileHandle[] = [];
  try {
    handles.push(await open(root, constants.O_DIRECTORY | constants.O_NOFOLLOW));
    for (const part of [...directory, ...parts]) {
      handles.push(await open(join("/proc/self/fd", String(handles.at(-1)!.fd), part),
        constants.O_DIRECTORY | constants.O_NOFOLLOW));
    }
    return await access(join("/proc/self/fd", String(handles.at(-1)!.fd), name), name);
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

export async function readRemoteFile(root: string, target: string, signal: AbortSignal): Promise<ChatFile | undefined> {
  return withFile(root, target, true, async (path, name) => {
    await using file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    const { size } = stat;
    if (!stat.isFile() || size < 1 || size > maxChatFileBytes) return;
    const bytes = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset === size) return { name, bytes: bytes.subarray(0, offset) };
  });
}

export async function writeRemoteFile(root: string, target: string, bytes: Uint8Array, overwrite: boolean, current: () => boolean | Promise<boolean>) {
  if (!bytes.length || bytes.length > maxChatFileBytes) return false;
  return await withFile(root, target, false, async (path) => {
    if (!await current()) return false;
    const staged = join(path, "..", `.${basename(path)}.${crypto.randomUUID()}`);
    const temporary = await open(staged, "wx", 0o600);
    try {
      try {
        await temporary.writeFile(bytes);
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      if (!await current()) return false;
      if (overwrite) await rename(staged, path);
      else await link(staged, path);
      return true;
    } finally {
      await rm(staged, { force: true });
    }
  }) ?? false;
}
