import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { parseDocument } from "yaml";
import { builtInDirectories } from "./builtin-modules.ts";
import { parseInstallName } from "./install-command.ts";
import { isGitRevision } from "./local-git.ts";
import { rejectionReason, repositoryKey } from "./plugins/policy.ts";

export interface ApprovedInstall {
  readonly name: string;
  readonly directory: string;
  readonly url: string;
  readonly branch: string;
  readonly revision: string;
}

export interface InstallCatalogItem {
  readonly name: string;
  readonly url: string;
  readonly approved: boolean;
}

export interface InstallCatalog {
  readonly list: readonly InstallCatalogItem[];
  resolve(name: string): ApprovedInstall | undefined;
}

const legacySources = [
  ["Atlas", "https://gitee.com/Nwflower/atlas"],
  ["genshin", "https://git.trss.me/Yunzai-genshin"],
  ["DF-Plugin", "https://gitee.com/DenFengLai/DF-Plugin"],
  ["ws-plugin", "https://gitee.com/xiaoye12123/ws-plugin"],
  ["TRSS-Plugin", "https://git.trss.me/TRSS-Plugin"],
  ["miao-plugin", "https://gitcode.com/TimeRainStarSky/miao-plugin.git"],
  ["Philia-Plugin", "https://org.trss.me/Yunzai-Philia-Plugin"],
  ["Guoba-Plugin", "https://gitee.com/guoba-yunzai/guoba-plugin"],
  ["yenai-plugin", "https://gitee.com/yeyang52/yenai-plugin"],
  ["flower-plugin", "https://gitee.com/Nwflower/flower-plugin"],
  ["xianyu-plugin", "https://gitee.com/suancaixianyu/xianyu-plugin"],
  ["earth-k-plugin", "https://gitee.com/SmallK111407/earth-k-plugin"],
  ["useless-plugin", "https://gitee.com/SmallK111407/useless-plugin"],
  ["StarRail-plugin", "https://gitee.com/hewang1an/StarRail-plugin"],
  ["xiaoyao-cvs-plugin", "https://gitcode.com/TimeRainStarSky/xiaoyao-cvs-plugin.git"],
  ["trss-xianxin-plugin", "https://gitee.com/snowtafir/xianxin-plugin"],
  ["Telegram-Plugin", "https://git.trss.me/Yunzai-Telegram-Plugin"],
  ["Discord-Plugin", "https://git.trss.me/Yunzai-Discord-Plugin"],
  ["WeChat-Plugin", "https://git.trss.me/Yunzai-WeChat-Plugin"],
  ["QQBot-Plugin", "https://git.trss.me/Yunzai-QQBot-Plugin"],
  ["Route-Plugin", "https://git.trss.me/Yunzai-Route-Plugin"],
  ["ICQQ-Plugin", "https://git.trss.me/Yunzai-ICQQ-Plugin"],
  ["KOOK-Plugin", "https://git.trss.me/Yunzai-KOOK-Plugin"],
  ["Secluded-Plugin", "https://github.com/Lovely02Y/Secluded-Adapter"],
] as const;

const reservedDirectories = new Set(["node_modules", ...builtInDirectories.values()]);
const entryFields = new Set(["directory", "url", "branch", "revision", "aliases"]);
const maxConfigBytes = 256 * 1024;
const invalid = () => new Error($t("lib.install-catalog.text_470e445d98"));

function fields(value: unknown): ReadonlyMap<unknown, unknown> | undefined {
  if (value instanceof Map) return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === null || prototype === Object.prototype) return new Map(Object.entries(value));
}

function catalogName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() !== value) return;
  const name = parseInstallName(value);
  if (!name || name === "插件" || parseInstallName(name) !== name) return;
  return name;
}

function normalizeRepository(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048 ||
      !/^https:\/\/[^/@\\%?#\s\u0000-\u001f\u007f-\u009f]+(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){1,2}\/?$/iu.test(value) ||
      value.trim() !== value) return;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) return;
    return parsed.href.replace(/\/$/u, "");
  } catch {
    return;
  }
}

function catalogRepositoryKey(url: string): string {
  const parsed = new URL(url);
  return repositoryKey(url) ?? `${parsed.host}${parsed.pathname.replace(/\.git$/iu, "")}`.toLowerCase();
}

export function installRejection(url: string, ...names: string[]): string | undefined {
  const key = repositoryKey(url);
  const repository = new URL(url).pathname.replace(/\.git$/iu, "").split("/").at(-1)?.toLowerCase() ?? "";
  return rejectionReason([...names.map((name) => name.toLowerCase()), key ?? "", repository], []);
}

function validBranch(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && !value.startsWith("refs/") && !value.includes("..") &&
    !value.endsWith(".") && value.split("/").every((part) =>
      /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(part) && part.trim() === part && !part.toLowerCase().endsWith(".lock"));
}

export function normalizeApprovedInstall(value: unknown): ApprovedInstall | undefined {
  const input = fields(value);
  if (!input) return;
  const name = catalogName(input.get("name"));
  const directory = input.get("directory");
  const url = normalizeRepository(input.get("url"));
  const branch = input.get("branch");
  const rawRevision = input.get("revision");
  const revision = typeof rawRevision === "string" ? rawRevision.toLowerCase() : "";
  if (!name || typeof directory !== "string" || directory.length > 64 || directory.trim() !== directory ||
      parseInstallName(directory) === undefined || reservedDirectories.has(directory.toLowerCase()) ||
      !url || !validBranch(branch) || !isGitRevision(revision) || revision.trim() !== revision) return;
  return Object.freeze({ name, directory, url, branch, revision });
}

export function normalizeInstallCatalog(value?: unknown): InstallCatalog {
  const config = value == null ? new Map() : fields(value);
  if (!config || [...config.keys()].some((key) => key !== "plugins")) throw invalid();
  const entries = config.has("plugins") ? fields(config.get("plugins")) : new Map();
  if (!entries || entries.size > 128) throw invalid();

  const approved = new Map<string, ApprovedInstall>();
  const names = new Set<string>();
  const directories = new Set<string>();
  const repositories = new Set<string>();
  const items: ApprovedInstall[] = [];
  for (const [name, input] of entries) {
    const entry = fields(input);
    if (!entry || [...entry.keys()].some((key) => typeof key !== "string" || !entryFields.has(key))) throw invalid();
    const plugin = normalizeApprovedInstall({ name, directory: entry.get("directory"), url: entry.get("url"),
      branch: entry.get("branch"), revision: entry.get("revision") });
    if (!plugin) throw invalid();
    const directory = plugin.directory.toLowerCase();
    const repository = catalogRepositoryKey(plugin.url);
    if (directories.has(directory) || repositories.has(repository)) throw invalid();
    directories.add(directory);
    repositories.add(repository);

    const aliases = entry.has("aliases") ? entry.get("aliases") : [];
    if (!Array.isArray(aliases) || aliases.length > 32) throw invalid();
    for (const label of [name, ...aliases]) {
      const alias = catalogName(label);
      if (!alias || names.has(alias.toLowerCase())) throw invalid();
      names.add(alias.toLowerCase());
      approved.set(alias, plugin);
    }
    items.push(plugin);
  }

  function resolve(name: string) {
    const alias = catalogName(name);
    return alias ? approved.get(alias) : undefined;
  }

  const represented = new Set<ApprovedInstall>();
  const list: InstallCatalogItem[] = legacySources.map(([name, url]) => {
    const entry = resolve(name);
    const approved = entry !== undefined && entry.url === normalizeRepository(url);
    if (approved) represented.add(entry);
    return { name, url, approved };
  });
  for (const entry of items) {
    if (!represented.has(entry)) list.push({ name: entry.name, url: entry.url, approved: true });
  }
  return { list, resolve };
}

export async function readInstallCatalog(root: URL): Promise<InstallCatalog> {
  for (const path of ["config/install.yaml", "config/config/install.yaml"]) {
    const file = await open(new URL(path, root), constants.O_RDONLY | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return;
      throw new Error($t("lib.install-catalog.text_337384fa21") + path + "。");
    });
    if (!file) continue;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maxConfigBytes) throw invalid();
      const bytes = await file.readFile();
      if (bytes.length > maxConfigBytes) throw invalid();
      const document = parseDocument(bytes.toString("utf8"), { strict: true, uniqueKeys: true, merge: false });
      if (document.errors.length || document.warnings.length) throw invalid();
      return normalizeInstallCatalog(document.toJS({ mapAsMap: true, maxAliasCount: 0 }));
    } catch {
      throw new Error($t("lib.install-catalog.text_337384fa21") + path + "。");
    } finally {
      await file.close();
    }
  }
  return normalizeInstallCatalog();
}
