import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isNode, parseDocument, type Node } from "yaml";
import { GlobalConfigWriteError } from "./lotus-global-config-write.ts";
import { insertSourcePairs, replaceSourceScalar, sourceAliasOverrides, sourceMappingPair, type Pair, type SourceEdit } from "./yaml-source-edits.ts";

type Config = Readonly<Record<string, unknown>>;

function record(value: unknown): Config | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Config;
}

/** Video modules still accept older flat download fields when no nested download config is set. */
export function mediaDownloadSource(config: Config): Config {
  return config.download ? record(config.download) ?? {} : config;
}

export function editMediaDownloadSettings(text: string, local: Config, effective: Config,
  section: "bilibili" | "douyin", downloadKeys: readonly string[], top: Config, downloadChanges?: Config) {
  const yaml = parseDocument(text, { strict: true, merge: true, uniqueKeys: true, keepSourceTokens: true });
  if (yaml.errors.length || (yaml.contents && !isMap(yaml.contents))) throw new GlobalConfigWriteError("config");
  const prior = record(effective[section]) ?? {};
  if (effective[section] !== undefined && !record(effective[section])) throw new GlobalConfigWriteError("config");
  const readDownload = mediaDownloadSource(prior);
  const download = record(prior.download) ?? Object.fromEntries(downloadKeys.filter(key => Object.hasOwn(readDownload, key))
    .map(key => [key, readDownload[key]]));
  const next = { ...prior, ...top, ...(downloadChanges ? { download: { ...download, ...downloadChanges } } : {}) };
  const edits: SourceEdit[] = [];
  function insert(node: Node | undefined, additions: Pair[]) {
    if (!additions.length) return;
    if (isAlias(node)) edits.push(sourceAliasOverrides(text, node, additions));
    else if (node === undefined || isMap(node)) edits.push(insertSourcePairs(text, node, additions));
    else throw new GlobalConfigWriteError("config");
  }
  function writeScalars(node: Node, values: Config, additions: Pair[]) {
    for (const [key, value] of Object.entries(values)) {
      const source = isMap(node) ? node.get(key, true) : undefined;
      const flow = JSON.stringify(value);
      if (isNode(source)) edits.push(replaceSourceScalar(text, source, flow));
      else additions.push({ key, flow, block: [`${key}: ${flow}`] });
    }
  }
  const source = isMap(yaml.contents) ? yaml.contents.get(section, true) : undefined;
  if (!isNode(source)) {
    insert(yaml.contents ?? undefined, [sourceMappingPair(section, next)]);
  } else {
    const additions: Pair[] = [];
    writeScalars(source, top, additions);
    if (downloadChanges && next.download) {
      const nested = isMap(source) ? source.get("download", true) : undefined;
      if (isMap(nested) || isAlias(nested)) {
        const nestedAdditions: Pair[] = [];
        writeScalars(nested, downloadChanges, nestedAdditions);
        insert(nested, nestedAdditions);
      } else if (isNode(nested)) {
        if (prior.download) throw new GlobalConfigWriteError("config");
        edits.push(replaceSourceScalar(text, nested, JSON.stringify(next.download)));
      } else additions.push(sourceMappingPair("download", next.download!));
    }
    insert(source, additions);
  }
  const result = edits.sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((content, edit) => content.slice(0, edit.start) + edit.value + content.slice(edit.end), text);
  if (!isDeepStrictEqual(Bun.YAML.parse(result), { ...local, [section]: next })) throw new GlobalConfigWriteError("config");
  return { yaml: result, document: { [section]: next } };
}
