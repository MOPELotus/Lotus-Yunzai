import { lstat, readlink } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

// Check each intermediate path before resolving its next link. An old supervisor can
// leave an otherwise valid chain dangling while the referenced files are in the archive.
export async function findLinkedPath(path: string, matches: (path: string) => boolean | Promise<boolean>): Promise<string | undefined> {
  const visited = new Set<string>();
  let target = resolve(path);
  try {
    for (let depth = 0; depth <= 40 && !visited.has(target); depth++) {
      visited.add(target);
      if (await matches(target)) return target;

      let link = parse(target).root;
      let next: string | undefined;
      for (const part of relative(link, target).split(sep)) {
        link = join(link, part);
        if (!(await lstat(link)).isSymbolicLink()) continue;
        next = resolve(dirname(link), await readlink(link), relative(link, target));
        break;
      }
      if (!next) return;
      target = next;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP") throw error;
  }
}
