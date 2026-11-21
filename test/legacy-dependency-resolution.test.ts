import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkRetainedHostDependency } from "../lib/plugins/legacy-dependency-resolution.ts";

let temporary: string | undefined;
afterEach(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
  temporary = undefined;
});

async function fixture() {
  temporary = await mkdtemp(join(tmpdir(), "lotus-retained-resolution-"));
  const host = join(temporary, "target");
  const importer = join(host, "plugins", "old-plugin", "apps");
  await mkdir(join(host, "plugins"), { recursive: true });
  return { host, importer };
}

async function dependency(directory: string, name: string, version: string) {
  await mkdir(directory, { recursive: true });
  await Bun.write(join(directory, "package.json"), JSON.stringify({
    name, version, exports: { ".": "./index.js", "./sub": "./sub.js" },
  }));
  for (const filename of ["index.js", "sub.js"]) {
    await Bun.write(join(directory, filename), "throw new Error('static dependency check executed code')");
  }
}

test("resolves an existing host package and export subpath from a final directory that does not yet exist", async () => {
  const { host, importer } = await fixture();
  await dependency(join(host, "node_modules", "fixture"), "fixture", "2.9.1");
  expect(await checkRetainedHostDependency(host, importer, "fixture/sub", "^2.9.0"))
    .toEqual({ status: "host", version: "2.9.1" });
  expect(await checkRetainedHostDependency(host, importer, "fixture", "^3.0.0"))
    .toEqual({ status: "unverified", reason: "version" });
  expect(await checkRetainedHostDependency(host, importer, "fixture", "latest"))
    .toEqual({ status: "unverified", reason: "version" });
  expect(await checkRetainedHostDependency(host, importer, "fixture", "file:/wrong-target"))
    .toEqual({ status: "unverified", reason: "version" });
  expect(await checkRetainedHostDependency(host, importer, "fixture/nonexistent"))
    .toEqual({ status: "unverified", reason: "missing" });
});

test("rejects package resolution from an ancestor outside the host and follows in-host workspace links", async () => {
  const { host, importer } = await fixture();
  await dependency(join(dirname(host), "node_modules", "outside"), "outside", "1.0.0");
  await dependency(join(host, "packages", "workspace"), "@current/workspace", "1.1.0");
  await mkdir(join(host, "node_modules", "@current"), { recursive: true });
  await symlink("../../packages/workspace", join(host, "node_modules", "@current", "workspace"));
  expect(await checkRetainedHostDependency(host, importer, "outside"))
    .toEqual({ status: "unverified", reason: "outside-host" });
  expect(await checkRetainedHostDependency(host, importer, "@current/workspace", "^1.0.0"))
    .toEqual({ status: "host", version: "1.1.0" });
});

test("keeps Node and Bun builtins distinct from runtime compatibility aliases", async () => {
  const { host, importer } = await fixture();
  for (const name of ["node:fs", "fs", "bun", "bun:sqlite"]) {
    expect(await checkRetainedHostDependency(host, importer, name)).toEqual({ status: "runtime" });
  }
  expect(await checkRetainedHostDependency(host, importer, "node-fetch")).toEqual({ status: "runtime" });
  expect(await checkRetainedHostDependency(host, importer, "node-fetch", undefined, "require"))
    .toEqual({ status: "unverified", reason: "runtime-alias" });
  for (const name of ["ws", "node-fetch"]) {
    expect(await checkRetainedHostDependency(host, importer, name, "^3.0.0"))
      .toEqual({ status: "unverified", reason: "runtime-alias" });
  }
  expect(await checkRetainedHostDependency(host, importer, "../legacy.js"))
    .toEqual({ status: "unverified", reason: "unsupported-specifier" });
  expect(await checkRetainedHostDependency(host, importer, "bun:not-a-runtime-dummy"))
    .toEqual({ status: "unverified", reason: "missing" });
});

test("checks the conditional export used by the original import or require", async () => {
  const { host, importer } = await fixture();
  const directory = join(host, "node_modules", "conditional");
  await dependency(directory, "conditional", "1.0.0");
  await Bun.write(join(directory, "package.json"), JSON.stringify({
    name: "conditional", version: "1.0.0", exports: { "./esm": { import: "./index.js" } },
  }));
  expect(await checkRetainedHostDependency(host, importer, "conditional/esm", undefined, "import"))
    .toEqual({ status: "host", version: "1.0.0" });
  expect(await checkRetainedHostDependency(host, importer, "conditional/esm", undefined, "require"))
    .toEqual({ status: "unverified", reason: "missing" });
});
