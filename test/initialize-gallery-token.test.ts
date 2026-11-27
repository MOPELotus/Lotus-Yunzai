import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { initializeRuntimeResources } from "../lib/initialize-resources.ts";

test("bootstrap passes the optional GitHub token to gallery synchronization", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-bootstrap-gallery-"));
  const previous = Bun.env.GITHUB_TOKEN;
  const key = Symbol.for("lotus-init-token-fixture");
  try {
    await mkdir(join(root, "lib"));
    await writeFile(join(root, "lib/character-gallery-sync.ts"),
      'export async function syncCharacterGallery(options) { globalThis[Symbol.for("lotus-init-token-fixture")] = options; }');
    Bun.env.GITHUB_TOKEN = " fixture-token ";
    await initializeRuntimeResources(pathToFileURL(root + "/"), new AbortController().signal, {});
    const captured = (globalThis as Record<symbol, { githubToken?: string; root?: string }>)[key];
    expect(captured?.githubToken).toBe("fixture-token");
    expect(captured?.root).toBe(join(root, "data/character-gallery-synced/"));
  } finally {
    if (previous === undefined) delete Bun.env.GITHUB_TOKEN; else Bun.env.GITHUB_TOKEN = previous;
    delete (globalThis as Record<symbol, unknown>)[key];
    await rm(root, { recursive: true, force: true });
  }
});
