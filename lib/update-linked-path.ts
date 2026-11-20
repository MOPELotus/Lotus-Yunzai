import { lstat, readlink } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

interface LinkedPathOptions {
  readonly match?: (path: string) => boolean | Promise<boolean>;
  readonly readLink?: (path: string) => Promise<string | undefined>;
  readonly onLink?: (path: string) => void;
}

export async function readPathLink(path: string): Promise<string | undefined> {
  if ((await lstat(path)).isSymbolicLink()) return readlink(path);
}

// Check each intermediate path before resolving its next link. An old supervisor can
// leave an otherwise valid chain dangling while the referenced files are in the archive.
export async function resolveLinkedPath(path: string, options: LinkedPathOptions): Promise<string | undefined> {
  const readLink = options.readLink ?? readPathLink;
  const visited = new Set<string>();
  let target = resolve(path);
  try {
    for (let depth = 0; depth <= 40 && !visited.has(target); depth++) {
      visited.add(target);
      if (await options.match?.(target)) return target;

      let link = parse(target).root;
      let next: string | undefined;
      for (const part of relative(link, target).split(sep)) {
        link = join(link, part);
        const destination = await readLink(link);
        if (destination === undefined) continue;
        options.onLink?.(link);
        next = resolve(dirname(link), destination, relative(link, target));
        break;
      }
      if (!next) return options.match ? undefined : target;
      target = next;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP") throw error;
  }
}
