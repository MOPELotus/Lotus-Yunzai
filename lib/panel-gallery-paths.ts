import { readlink, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const installationRoot = fileURLToPath(new URL("../", import.meta.url));

export function localPanelGalleryRoot(installation = installationRoot) {
  return join(installation, "data", "character-gallery");
}

export function localSyncedPanelGalleryRoot(installation = installationRoot) {
  return join(installation, "data", "character-gallery-synced", "current");
}

export function isSyncedPanelGallerySnapshot(value: unknown): value is string {
  return typeof value === "string" && /^gallery-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
}

export async function readSyncedPanelGalleryRoot(installation = installationRoot, snapshot?: string) {
  const current = localSyncedPanelGalleryRoot(installation);
  const pointer = snapshot === undefined ? await readlink(current).catch(() => undefined) : undefined;
  const name = snapshot ?? pointer?.slice("snapshots/".length);
  if (!isSyncedPanelGallerySnapshot(name) || (snapshot === undefined && pointer !== `snapshots/${name}`)) return;
  const selected = resolve(dirname(current), "snapshots", name);
  if (await realpath(selected).catch(() => undefined) !== selected) return;
  if ((await stat(selected).catch(() => undefined))?.isDirectory()) return selected;
}

export async function retainedPanelGalleryDirectory(game: "gs" | "sr" | "zzz", installation = installationRoot) {
  const directory = join(installation, "backup", "plugins", ...(game === "zzz"
    ? ["ZZZ-Plugin", "resources", "images", "panel"]
    : ["miao-plugin", "resources", "profile", "normal-character"]));
  if (await realpath(directory).catch(() => undefined) === directory &&
      (await stat(directory).catch(() => undefined))?.isDirectory()) return directory;
}
