import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isManagedPluginDirectory } from "../managed-update-protocol.ts";
import { readMigrationSourceFile } from "../migration-files.ts";
import { selectApprovedProtocolCandidates, type ApprovedProtocolReplacement } from "./legacy-protocol-replacements.ts";
import { planMigration, withinInstallation, type LegacyMigrationPlan } from "./migration-plan.ts";

interface ReplacementPaths {
  /** The installer creates a local package here and never runs its lifecycle scripts. */
  readonly packageDirectory: string;
  /** The installer writes configuration to this path with private permissions. */
  readonly configFile: string;
}

export interface ProtocolReplacementInstaller {
  readonly prepare: (replacement: ApprovedProtocolReplacement, legacyDirectory: string,
    paths: ReplacementPaths, signal?: AbortSignal) => Promise<boolean>;
  /** Verifies both the package pin and normalized configuration without starting a connection. */
  readonly verify: (replacement: ApprovedProtocolReplacement, paths: ReplacementPaths,
    signal?: AbortSignal) => Promise<boolean>;
}

export interface ProtocolMigrationOptions {
  readonly approvals: readonly ApprovedProtocolReplacement[];
  readonly installer: ProtocolReplacementInstaller;
}

interface PreparedReplacement extends ReplacementPaths {
  readonly id: string;
  readonly legacyPath: string;
  readonly directory: string;
  readonly packageFiles: readonly { readonly path: string; readonly sha256: string }[];
  /** Private preparation data. Public reports only include id and legacyPath. */
  readonly configSha256: string;
  readonly packageTreeSha256: string;
  readonly packageName: string;
  readonly approvalSha256: string;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function attest(directory: string, paths: ReplacementPaths, signal?: AbortSignal) {
  const [pkg, config] = await Promise.all([lstat(paths.packageDirectory), lstat(paths.configFile)]);
  if (!pkg.isDirectory() || (pkg.mode & 0o6000) || !config.isFile() || (config.mode & 0o6077) ||
      await realpath(paths.packageDirectory) !== paths.packageDirectory) return;
  const candidates = (await readdir(paths.packageDirectory, { recursive: true, withFileTypes: true }))
    .sort((a, b) => {
      const first = join(a.parentPath, a.name);
      const second = join(b.parentPath, b.name);
      return first < second ? -1 : first > second ? 1 : 0;
    });
  const files: { path: string; sha256: string }[] = [];
  if (candidates.length > 4096) return;
  let bytesRemaining = 64 * 1024 * 1024;
  let packageName: string | undefined;
  for (const entry of candidates) {
    signal?.throwIfAborted();
    if ([".git", ".env", "node_modules"].includes(entry.name) || entry.name.startsWith(".env.")) return;
    const absolute = join(entry.parentPath, entry.name);
    if ((await lstat(absolute)).mode & 0o6000) return;
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) return;
    const path = relative(paths.packageDirectory, absolute);
    const source = await readMigrationSourceFile(paths.packageDirectory, absolute, bytesRemaining, signal);
    if (!source) return;
    bytesRemaining -= source.bytes.length;
    if (path === "package.json") {
      const manifest = JSON.parse(source.bytes.toString("utf8"));
      if (typeof manifest?.name !== "string") return;
      packageName = manifest.name;
    }
    files.push({ path, sha256: sha256(source.bytes) });
  }
  if (!packageName) return;
  const configuration = await readMigrationSourceFile(directory, paths.configFile, 256 * 1024, signal);
  if (!configuration?.bytes.length) return;
  return { packageName, packageFiles: files, packageTreeSha256: sha256(Buffer.from(JSON.stringify(files))),
    configSha256: sha256(configuration.bytes) };
}

/** This only prepares data in a private staging root. Publication and old backup belong in the same caller transaction. */
export async function stageApprovedProtocolReplacements(plan: LegacyMigrationPlan, staging: string,
  { approvals, installer }: ProtocolMigrationOptions, signal?: AbortSignal) {
  const prepared: PreparedReplacement[] = [];
  const deferred: string[] = [];
  const candidates = selectApprovedProtocolCandidates(plan, approvals);
  if (!candidates.length) return { prepared, deferred };
  if (await realpath(staging) !== staging) throw new Error("协议迁移暂存须为实体目录。");
  const root = await lstat(staging);
  if (!root.isDirectory() || (root.mode & 0o077) ||
      [plan.source, plan.target].some(path => withinInstallation(path, staging) || withinInstallation(staging, path))) {
    throw new Error("协议迁移暂存须为独立私有目录。");
  }
  async function confirmPlan() {
    if (!isDeepStrictEqual(plan, await planMigration(plan.source, plan.target, approvals))) {
      throw new Error("旧协议插件或目标工作区已变化，请重新预检。");
    }
  }
  await confirmPlan();
  try {
    for (const { candidate, replacement } of candidates) {
      signal?.throwIfAborted();
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(replacement.id)) throw new Error("协议迁移批准项 ID 无效。");
      const legacy = join(plan.source, candidate.path);
      if (!(await lstat(legacy)).isDirectory() || await realpath(legacy) !== legacy) {
        deferred.push(candidate.path);
        continue;
      }
      const directory = await mkdtemp(join(staging, "protocol-"));
      const paths = {
        packageDirectory: join(directory, "data", "optional-protocols", replacement.id),
        configFile: join(directory, "config", "optional-protocols", replacement.id + ".yaml"),
      };
      let attestation: Awaited<ReturnType<typeof attest>>;
      try {
        await mkdir(dirname(paths.packageDirectory), { mode: 0o700, recursive: true });
        await mkdir(dirname(paths.configFile), { mode: 0o700, recursive: true });
        if (await installer.prepare(replacement, legacy, paths, signal)) {
          const before = await attest(directory, paths, signal);
          if (before?.packageName === replacement.target.packageName &&
              before.packageTreeSha256 === replacement.target.packageTreeSha256 &&
              await installer.verify(replacement, paths, signal)) {
            const after = await attest(directory, paths, signal);
            signal?.throwIfAborted();
            if (isDeepStrictEqual(before, after)) attestation = before;
          }
        }
        signal?.throwIfAborted();
      } catch {
        signal?.throwIfAborted();
      } finally {
        if (!attestation) await rm(directory, { recursive: true, force: true });
      }
      if (attestation) prepared.push({ id: replacement.id, legacyPath: candidate.path, directory, ...paths, ...attestation, approvalSha256: approvalDigest(replacement) });
      else deferred.push(candidate.path);
    }
    await confirmPlan();
    signal?.throwIfAborted();
    return { prepared, deferred };
  } catch (error) {
    await Promise.all(prepared.map(item => rm(item.directory, { recursive: true, force: true })));
    throw error;
  }
}

export interface StagedProtocolReceipt {
  readonly id: string;
  readonly legacyPath: string;
  readonly packageName: string;
  readonly packageTreeSha256: string;
  readonly configSha256: string;
  readonly approvalSha256: string;
}

export function protocolReceipt(prepared: PreparedReplacement): StagedProtocolReceipt {
  const { id, legacyPath, packageName, packageTreeSha256, configSha256, approvalSha256 } = prepared;
  return { id, legacyPath, packageName, packageTreeSha256, configSha256, approvalSha256 };
}

function approvalDigest(replacement: ApprovedProtocolReplacement) {
  const { id, legacy, target } = replacement;
  return sha256(Buffer.from(JSON.stringify([
    id, legacy.protocol, legacy.packageName, [...legacy.gitRemotes].sort(), legacy.manifestSha256,
    Object.keys(legacy.sourceFiles).sort().map(path => [path, legacy.sourceFiles[path]]),
    target.packageName, target.packageTreeSha256,
  ])));
}

export async function verifyStagedProtocolReceipts(root: string, receipts: readonly StagedProtocolReceipt[],
  options?: ProtocolMigrationOptions, signal?: AbortSignal) {
  if (!receipts.length) return;
  if (!options?.installer || !options.approvals?.length) throw new Error("继续附加协议迁移需要同一批准清单和验证器。");
  const ids = new Set<string>();
  for (const receipt of receipts) {
    signal?.throwIfAborted();
    if (!receipt || typeof receipt.id !== "string" || typeof receipt.legacyPath !== "string") {
      throw new Error("附加协议迁移记录无效。");
    }
    const { id, legacyPath } = receipt;
    if (ids.has(id) || !/^[a-z][a-z0-9-]{0,63}$/u.test(id) || !legacyPath.startsWith("plugins/") ||
        !isManagedPluginDirectory(legacyPath.slice("plugins/".length))) throw new Error("附加协议迁移记录无效。");
    ids.add(id);
    const approved = options.approvals.filter(item => item.id === id);
    const replacement = approved?.length === 1 ? approved[0] : undefined;
    if (!replacement || approvalDigest(replacement) !== receipt.approvalSha256 ||
        replacement.target.packageName !== receipt.packageName ||
        replacement.target.packageTreeSha256 !== receipt.packageTreeSha256) {
      throw new Error("附加协议的当前批准清单与暂存不一致。");
    }
    const paths = {
      packageDirectory: join(root, "data", "optional-protocols", id),
      configFile: join(root, "config", "optional-protocols", id + ".yaml"),
    };
    try {
      const before = await attest(root, paths, signal);
      if (before?.packageName === receipt.packageName && before.packageTreeSha256 === receipt.packageTreeSha256 &&
          before.configSha256 === receipt.configSha256 && await options.installer.verify(replacement, paths, signal) &&
          isDeepStrictEqual(before, await attest(root, paths, signal))) continue;
    } catch {
      signal?.throwIfAborted();
    }
    throw new Error("附加协议包、配置或旧目录备份校验失败。");
  }
}
