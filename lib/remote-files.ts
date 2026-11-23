import { constants } from "node:fs";
import { link, open, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { isChatFileName, maxChatFileBytes, type ChatFile } from "./chat-files.ts";

function segments(root: string, target: string) {
  const segments = (isAbsolute(target) ? relative(root, target) : target).split(sep);
  if (!segments.every(isChatFileName)) return;
  return segments;
}

async function withFile<T>(root: string, target: string, access: (file: string, name: string) => Promise<T>): Promise<T | undefined> {
  const parts = segments(root, target);
  if (!parts || process.platform !== "linux") return;
  const handles: FileHandle[] = [];
  const name = parts.pop()!;
  try {
    handles.push(await open(root, constants.O_DIRECTORY | constants.O_NOFOLLOW));
    for (const part of parts) {
      handles.push(await open(join("/proc/self/fd", String(handles.at(-1)!.fd), part),
        constants.O_DIRECTORY | constants.O_NOFOLLOW));
    }
    return await access(join("/proc/self/fd", String(handles.at(-1)!.fd), name), name);
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

export async function readRemoteFile(root: string, target: string, signal: AbortSignal): Promise<ChatFile | undefined> {
  return withFile(root, target, async (path, name) => {
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

export async function writeRemoteFile(root: string, target: string, bytes: Uint8Array, overwrite: boolean, current: () => boolean) {
  if (!bytes.length || bytes.length > maxChatFileBytes) return false;
  return await withFile(root, target, async (path) => {
    if (!current()) return false;
    const staged = join(path, "..", `.${basename(path)}.${crypto.randomUUID()}`);
    const temporary = await open(staged, "wx", 0o600);
    try {
      await temporary.writeFile(bytes);
      await temporary.sync();
      if (!current()) return false;
      if (overwrite) await rename(staged, path);
      else await link(staged, path);
      return true;
    } finally {
      await temporary.close();
      await rm(staged, { force: true });
    }
  }) ?? false;
}
