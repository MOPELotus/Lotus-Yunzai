import { link, lstat, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function move(source: string, destination: string) {
  if (await exists(destination)) throw new Error("切换目标已存在。");
  await rename(source, destination);
  const parent = dirname(source);
  await syncDirectory(parent);
  if (dirname(destination) !== parent) await syncDirectory(dirname(destination));
}

export async function writeJournal(path: string, entry: object, exclusive: boolean) {
  const temporary = `${path}.${crypto.randomUUID()}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(entry));
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeJournal(path: string) {
  await rm(path);
  await syncDirectory(dirname(path));
}
