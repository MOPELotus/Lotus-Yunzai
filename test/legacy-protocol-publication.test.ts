import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ApprovedProtocolReplacement } from "../lib/plugins/legacy-protocol-replacements.ts";
import type { ProtocolMigrationOptions } from "../lib/plugins/legacy-protocol-stage.ts";
import { migrateInstallation } from "../scripts/migrate.ts";

const id = "fixture-replacement";
const legacyPath = "plugins/qqbot-plugin";
const legacyManifest = '{"name":"qqbot-plugin"}';
const legacyEntry = "throw new Error('do not launch the old adapter');";
const packageManifest = '{"name":"lotus-test-adapter"}';
const packageEntry = "throw new Error('do not launch the new adapter');";
const configuration = "scopedFixture: true\n";
const configPath = `config/optional-protocols/${id}.yaml`;
const filePath = `data/optional-protocols/${id}/entry.ts`;
const backupPath = `backup/${legacyPath}`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const approval: ApprovedProtocolReplacement = {
  id,
  legacy: {
    protocol: "qqbot", packageName: "qqbot-plugin", gitRemotes: [],
    manifestSha256: digest(legacyManifest), sourceFiles: { "index.js": digest(legacyEntry) },
  },
  target: {
    packageName: "lotus-test-adapter",
    packageTreeSha256: digest(JSON.stringify([
      { path: "entry.ts", sha256: digest(packageEntry) },
      { path: "package.json", sha256: digest(packageManifest) },
    ])),
  },
};

async function put(root: string, path: string, contents: string) {
  const output = join(root, path);
  await mkdir(dirname(output), { mode: 0o700, recursive: true });
  await writeFile(output, contents, { mode: 0o600 });
}

async function fixture(run: (source: string, target: string) => Promise<void>) {
  const parent = await mkdtemp(join(tmpdir(), "lotus-optional-adapter-publish-"));
  try {
    const source = join(parent, "source");
    const target = join(parent, "target");
    await put(source, legacyPath + "/package.json", legacyManifest);
    await put(source, legacyPath + "/index.js", legacyEntry);
    await put(source, legacyPath + "/config/store.yaml", "originalSetup: true\n");
    await put(source, "config/config/group.yaml", "file_watch: false\n");
    await put(target, "package.json", '{"name":"lotus-yunzai"}');
    await put(target, "plugins/.keep", "");
    for (const args of [["init", "-q"], ["add", "."],
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid.test", "commit", "-qm", "fixture"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: target, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    }
    await run(source, target);
    expect(await readFile(join(source, legacyPath, "index.js"), "utf8")).toBe(legacyEntry);
    expect(await readFile(join(source, legacyPath, "config/store.yaml"), "utf8")).toBe("originalSetup: true\n");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function installer(verify: ProtocolMigrationOptions["installer"]["verify"]) {
  let preparations = 0;
  const options: ProtocolMigrationOptions = {
    approvals: [approval],
    installer: {
      async prepare(_approval, _legacy, paths) {
        preparations++;
        await put(paths.packageDirectory, "package.json", packageManifest);
        await put(paths.packageDirectory, "entry.ts", packageEntry);
        await put(dirname(paths.configFile), id + ".yaml", configuration);
        return true;
      },
      verify,
    },
  };
  return { options, preparations: () => preparations };
}

const expectAbsent = (root: string, path: string) =>
  expect(lstat(join(root, path))).rejects.toMatchObject({ code: "ENOENT" });

test.skipIf(!Bun.which("git"))("publishes the adapter, configuration and private old backup together", () => fixture(async (source, target) => {
  const { options, preparations } = installer(async (_approval, paths) =>
    await readFile(paths.configFile, "utf8") === configuration);
  const result = await migrateInstallation(source, target, undefined, options);
  expect(result).toMatchObject({
    status: "published", paths: ["backup", "config", "data"], archiveCount: 1,
    protocolReplacements: [{ id, legacyPath }], deferredPlugins: [],
  });
  expect(JSON.stringify(result)).not.toContain(digest(configuration));
  expect(await readFile(join(target, filePath), "utf8")).toBe(packageEntry);
  expect(await readFile(join(target, configPath), "utf8")).toBe(configuration);
  expect((await lstat(join(target, configPath))).mode & 0o777).toBe(0o600);
  expect((await lstat(join(target, "backup"))).mode & 0o077).toBe(0);
  expect(await readFile(join(target, backupPath, "config/store.yaml"), "utf8")).toBe("originalSetup: true\n");
  await expectAbsent(target, legacyPath);
  expect(await migrateInstallation(source, target)).toMatchObject({ status: "already-published" });
  expect(preparations()).toBe(1);
}));

test.skipIf(!Bun.which("git"))("retains the original protocol when no replacement is explicitly approved or preparation fails", async () => {
  for (const approved of [false, true]) {
    await fixture(async (source, target) => {
      const { options, preparations } = installer(async () => false);
      const result = await migrateInstallation(source, target, undefined, approved ? options : undefined);
      expect(preparations()).toBe(approved ? 1 : 0);
      expect(result).toMatchObject({
        status: "published", archiveCount: 0,
        deferredPlugins: [{ path: legacyPath, status: "protocol-candidate" }],
      });
      await expectAbsent(target, filePath);
      await expectAbsent(target, configPath);
      await expectAbsent(target, backupPath);
    });
  }
});

test.skipIf(!Bun.which("git"))("rejects conflicts and reverts the whole batch on final validation failure", () => fixture(async (source, target) => {
  let rejectFinal = true;
  const { options, preparations } = installer(async (_approval, paths) => {
    if (!paths.configFile.startsWith(target + "/")) return true;
    expect(await readFile(join(target, backupPath, "index.js"), "utf8")).toBe(legacyEntry);
    return !rejectFinal;
  });
  await put(target, "config/sentinel", "keep me");
  await expect(migrateInstallation(source, target, undefined, options)).rejects.toThrow(/已有 config/u);
  expect(await readFile(join(target, "config/sentinel"), "utf8")).toBe("keep me");
  await expectAbsent(target, "backup");
  await expectAbsent(target, "data");
  await rm(join(target, "config"), { recursive: true });
  await expect(migrateInstallation(source, target)).rejects.toThrow(/同一批准清单/u);
  const prepared = join(dirname(target), ".target.lotus-migration-prepared", "payload");
  await put(prepared, configPath, configuration + "tampered: true\n");
  await expect(migrateInstallation(source, target, undefined, options)).rejects.toThrow(/备份校验失败/u);
  for (const path of ["backup", "config", "data"]) await expectAbsent(target, path);
  await put(prepared, configPath, configuration);
  const oldConfigPath = join(backupPath, "config", "store.yaml");
  await put(prepared, oldConfigPath, "broken backup\n");
  await expect(migrateInstallation(source, target, undefined, options)).rejects.toThrow(/归档已存在/u);
  for (const path of ["backup", "config", "data"]) await expectAbsent(target, path);
  await put(prepared, oldConfigPath, "originalSetup: true\n");
  await expect(migrateInstallation(source, target, undefined, options)).rejects.toThrow(/备份校验失败/u);
  for (const path of ["backup", "config", "data"]) await expectAbsent(target, path);
  rejectFinal = false;
  expect(await migrateInstallation(source, target, undefined, options)).toMatchObject({ status: "published" });
  expect(preparations()).toBe(1);
  expect(await readFile(join(target, filePath), "utf8")).toBe(packageEntry);
  expect(await readFile(join(target, backupPath, "index.js"), "utf8")).toBe(legacyEntry);
}));
