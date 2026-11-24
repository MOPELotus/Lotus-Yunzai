import { fileURLToPath } from "node:url";

/** Repository-owned default artwork; runtime data and operator overrides stay separate. */
export function builtinResourceDirectory(path: string, root = new URL("../", import.meta.url)): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/u.test(path) || path.split("/").some(part => part === "." || part === "..")) {
    throw new Error("内置素材目录无效。");
  }
  return fileURLToPath(new URL(`resources/builtin/${path.replace(/\/$/u, "")}/`, root));
}
