import { createHash } from "node:crypto";
import { builtInDirectories } from "../builtin-modules.ts";
import { rejectionReason, repositoryKey } from "./policy.ts";

export const pluginScriptExtensions: ReadonlySet<string> = new Set([".js", ".mjs", ".cjs", ".ts"]);
const retiredScripts = new Map([
  ["c56d66b96534430c0b144051ffb5fbec74f8febec3acbb85ddc9c00427faba98", "咕咕牛图库管理器"],
]);

interface PluginMetadata {
  readonly name: string;
  readonly declaredName: string;
  readonly repositoryKeys: readonly string[];
  readonly identities: readonly string[];
  readonly entry?: string;
  readonly rejection?: string;
  readonly rejectionIdentity?: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function retiredPluginScript(source: Uint8Array): string | undefined {
  const hash = createHash("sha256").update(source).digest("hex");
  return retiredScripts.get(hash);
}

export function inspectPluginMetadata(directory: string, source: string | undefined, urls: readonly string[]): PluginMetadata {
  const manifest = record(source === undefined ? undefined : JSON.parse(source.replace(/^\uFEFF/u, "")));
  const meta = record(manifest.lotusYunzai);
  const declaredName = typeof manifest.name === "string" ? manifest.name.trim().toLowerCase() : "";
  const name = declaredName || directory.toLowerCase();
  const repository = typeof manifest.repository === "string" ? manifest.repository : record(manifest.repository).url;
  const repositories = (typeof repository === "string" ? [...urls, repository] : urls)
    .map(repositoryKey).filter((key) => key !== undefined);
  const result = {
    name, declaredName, repositoryKeys: repositories, identities: [`name:${name}`, ...repositories.map((key) => `repo:${key}`)],
  };
  const names = [directory.toLowerCase(), name, name.split("/").at(-1) ?? "",
    ...repositories, ...repositories.map((key) => key.split("/")[1] ?? "")];
  const games = Array.isArray(meta.games) ? meta.games.filter((game) => typeof game === "string") : [];
  const rejection = rejectionReason(names, games);
  if (rejection) return { ...result, rejection, rejectionIdentity: declaredName || repositories[0] || directory };

  const { entry } = meta;
  if (entry !== undefined && (typeof entry !== "string" || !declaredName)) {
    throw new Error("清单模块须声明包名和入口路径。");
  }
  const builtInDirectory = builtInDirectories.get(name);
  if (builtInDirectory !== undefined && directory !== builtInDirectory) {
    return { ...result, rejection: `${name} 的内置目录为 plugins/${builtInDirectory}。` };
  }
  return { ...result, entry };
}
