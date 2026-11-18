import { cp, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";

export async function copyHost(root: string) {
  await cp(new URL("../lib", import.meta.url), join(root, "lib"), { recursive: true });
  await cp(new URL("../app.ts", import.meta.url), join(root, "app.ts"));
  await symlink(join(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir");
  const system = join(root, "plugins", "system");
  await mkdir(system, { recursive: true });
  for (const file of ["package.json", "index.ts"]) {
    await cp(new URL(`../plugins/system/${file}`, import.meta.url), join(system, file));
  }
}
