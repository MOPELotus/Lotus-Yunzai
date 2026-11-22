import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { readMigrationSourceFile } from "./migration-files.ts";

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Inventory an unpacked adapter in the same order for migration and startup verification. */
export async function inspectOptionalProtocolPackage(directory: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const root = await lstat(directory);
  if (!root.isDirectory() || (root.mode & 0o6000) || await realpath(directory) !== directory) return;

  const entries = (await readdir(directory, { recursive: true, withFileTypes: true })).sort((a, b) => {
    const first = join(a.parentPath, a.name);
    const second = join(b.parentPath, b.name);
    return first < second ? -1 : first > second ? 1 : 0;
  });
  if (entries.length > 4096) return;

  const packageFiles: { path: string; sha256: string }[] = [];
  let bytesRemaining = 64 * 1024 * 1024;
  let manifest: (Record<string, unknown> & { readonly name: string }) | undefined;
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (entry.name === ".git" || entry.name === "node_modules" ||
        entry.name === ".env" || entry.name.startsWith(".env.")) return;
    const absolute = join(entry.parentPath, entry.name);
    const info = await lstat(absolute);
    if ((info.mode & 0o6000) || await realpath(absolute) !== absolute) return;
    if (entry.isDirectory() && info.isDirectory()) continue;
    if (!entry.isFile() || !info.isFile()) return;

    const path = relative(directory, absolute);
    const source = await readMigrationSourceFile(directory, absolute, bytesRemaining, signal);
    if (!source) return;
    bytesRemaining -= source.bytes.length;
    if (path === "package.json") {
      const value: unknown = JSON.parse(source.bytes.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) || !("name" in value) ||
          typeof value.name !== "string" || !value.name) return;
      manifest = { ...value, name: value.name };
    }
    packageFiles.push({ path, sha256: sha256(source.bytes) });
  }
  signal?.throwIfAborted();
  if (!manifest) return;
  return { manifest, packageFiles, packageTreeSha256: sha256(JSON.stringify(packageFiles)) };
}
