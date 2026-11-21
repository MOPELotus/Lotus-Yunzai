import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { lockFile } from "../file-lock.ts";
import { isManagedPluginDirectory } from "../managed-update-protocol.ts";
import { copyLocalPlugin } from "./local-plugin-copy.ts";
import { planMigration, withinInstallation, type LegacyMigrationPlan } from "./migration-plan.ts";

const browserPackages = new Set([
  "puppeteer", "puppeteer-core", "puppeteer-extra", "playwright", "playwright-core", "playwright-chromium",
  "playwright-firefox", "playwright-webkit", "chromium", "chromium-binary", "chrome-launcher",
  "chrome-remote-interface", "selenium-webdriver", "webdriverio", "phantomjs", "phantomjs-prebuilt",
  "@sparticuz/chromium", "@sparticuz/chromium-min",
]);
const javascript = new Bun.Transpiler({ loader: "js" });
const typescript = new Bun.Transpiler({ loader: "ts" });
const scanners = new Map([
  [".js", javascript], [".mjs", javascript], [".cjs", javascript],
  [".ts", typescript], [".mts", typescript], [".cts", typescript],
  [".jsx", new Bun.Transpiler({ loader: "jsx" })], [".tsx", new Bun.Transpiler({ loader: "tsx" })],
]);
const runtimeDependencies = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

interface RetainedInspection {
  readonly dependencies: readonly string[];
  readonly browser: readonly string[];
  readonly entry?: string;
}

async function optionalStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function browserName(specifier: string) {
  const name = /^(?:@[\w.-]+\/)?[\w.-]+/u.exec(specifier.replace(/^npm:/u, ""))?.[0];
  if (name && (browserPackages.has(name) || name.startsWith("@playwright/") ||
      name.startsWith("@puppeteer/") || name.startsWith("puppeteer-extra-plugin-"))) return name;
}

async function inspectStagedPlugin(root: string, signal?: AbortSignal): Promise<RetainedInspection> {
  const dependencies = new Set<string>();
  const browser = new Set<string>();
  let entry: string | undefined;
  const files = [root];
  while (files.length) {
    signal?.throwIfAborted();
    const path = files.pop()!;
    const info = await lstat(path);
    const scanner = scanners.get(extname(path));
    if (info.isDirectory()) {
      for (const name of await readdir(path)) files.push(join(path, name));
    } else if (info.isFile() && basename(path) === "package.json") {
      if (info.size > 256 * 1024) throw new Error("迁移插件清单超过预检大小上限。");
      const manifest = record(JSON.parse((await Bun.file(path).text()).replace(/^\uFEFF/u, "")));
      if (path === join(root, "package.json")) {
        const declared = record(manifest.lotusYunzai).entry;
        if (typeof declared === "string") entry = declared.replace(/^(?:\.\/)+/u, "");
      }
      for (const field of runtimeDependencies) {
        for (const [name, version] of Object.entries(record(manifest[field]))) {
          const pkg = browserName(name) || (typeof version === "string" && version.startsWith("npm:") ? browserName(version) : undefined);
          if (pkg) browser.add(pkg);
          if (/^(?:@[\w.-]+\/)?[\w.-]+$/u.test(name)) dependencies.add(name);
        }
      }
    } else if (info.isFile() && scanner) {
      if (info.size > 8 * 1024 * 1024) throw new Error("迁移插件脚本超过预检大小上限。");
      for (const { path: specifier } of scanner.scanImports(await Bun.file(path).text())) {
        const pkg = browserName(specifier);
        if (pkg) browser.add(pkg);
      }
    }
    // The copied tree's links can only reference an included ordinary file.
    // Inspect just that file's own path, without following a second spelling.
  }
  return { dependencies: [...dependencies].sort(), browser: [...browser].sort(), entry };
}

type RetainedPlugin = { readonly path: string; readonly dependencies: readonly string[] };
type HeldPlugin = { readonly path: string } & (
  { readonly reason: "browser-dependency"; readonly dependencies: readonly string[] } |
  { readonly reason: "retired-entry" });

/** Populate an isolated overlay. Only the later migration publisher may install it. */
export async function stageRetainedLegacyPlugins(plan: LegacyMigrationPlan, stagingPath: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const staging = await realpath(stagingPath);
  const stagingInfo = await lstat(staging);
  if (!stagingInfo.isDirectory()) throw new Error("兼容插件暂存根须为实体目录。");
  for (const path of [plan.source, plan.target]) {
    const canonical = await realpath(path);
    const info = await lstat(canonical);
    if (withinInstallation(canonical, staging) || withinInstallation(staging, canonical) ||
        (info.dev === stagingInfo.dev && info.ino === stagingInfo.ino)) throw new Error("兼容插件暂存根须与新旧安装独立。");
  }

  const retained: RetainedPlugin[] = [];
  const held: HeldPlugin[] = [];
  const destination = join(staging, "plugins");
  const lock = await lockFile(join(dirname(staging), `.${basename(staging)}.lotus-plugin-retain.sqlite`), "迁移兼容插件");
  let temporary: string | undefined;
  try {
    const confirmPlan = async () => {
      signal?.throwIfAborted();
      if (!isDeepStrictEqual(plan, await planMigration(plan.source, plan.target))) {
        throw new Error("旧插件或目标工作区已变化，请重新预检。");
      }
    };
    await confirmPlan();
    const targetRoot = await optionalStat(join(plan.target, "plugins"));
    if (targetRoot && !targetRoot.isDirectory()) throw new Error("目标插件根须为实体目录。");
    if (await optionalStat(destination)) throw new Error("兼容插件暂存目录已存在。");

    temporary = await mkdtemp(join(staging, ".lotus-retained-"));
    const stagedPlugins = join(temporary, "plugins");
    await mkdir(stagedPlugins, { mode: 0o700 });
    for (const entry of plan.plugins) {
      if (entry.status !== "retain") continue;
      signal?.throwIfAborted();
      const [prefix, name, ...rest] = entry.path.split("/");
      if (prefix !== "plugins" || !isManagedPluginDirectory(name) || rest.length) throw new Error("兼容插件路径无效。");
      if (await optionalStat(join(plan.target, entry.path))) throw new Error(`目标已有插件路径 ${entry.path}。`);
      const exclude = new Set(plan.plugins.flatMap(archived =>
        archived.status === "archive" && archived.kind === "script" && archived.path.startsWith(entry.path + "/")
          ? [archived.path.slice(entry.path.length + 1)] : []));
      const output = join(stagedPlugins, name);
      await copyLocalPlugin(join(plan.source, entry.path), output, signal, { exclude, rejectSpecialPermissions: true });
      const inspection = await inspectStagedPlugin(output, signal);
      if (exclude.has(inspection.entry ?? "index.js")) {
        held.push({ path: entry.path, reason: "retired-entry" });
      } else if (inspection.browser.length) {
        held.push({ path: entry.path, reason: "browser-dependency", dependencies: inspection.browser });
      } else {
        retained.push({ path: entry.path, dependencies: inspection.dependencies });
        continue;
      }
      await rm(output, { recursive: true });
    }
    await confirmPlan();
    if (!retained.length) return { status: "empty", retained, held } as const;
    if (await optionalStat(destination)) throw new Error("兼容插件暂存目录已存在。");
    await rename(stagedPlugins, destination);
    return { status: "published", directory: destination, retained, held } as const;
  } finally {
    try {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    } finally {
      lock.close();
    }
  }
}
