import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const installationRoot = fileURLToPath(new URL("../", import.meta.url));

export function localPanelGalleryRoot(installation = installationRoot) {
  return join(installation, "data", "character-gallery");
}

export async function retainedPanelGalleryDirectory(game: "gs" | "sr" | "zzz", installation = installationRoot) {
  const directory = join(installation, "backup", "plugins", ...(game === "zzz"
    ? ["ZZZ-Plugin", "resources", "images", "panel"]
    : ["miao-plugin", "resources", "profile", "normal-character"]));
  if (await realpath(directory).catch(() => undefined) === directory &&
      (await stat(directory).catch(() => undefined))?.isDirectory()) return directory;
}
