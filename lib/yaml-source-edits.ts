import { isAlias, isScalar, Parser, stringify, type Node, type YAMLMap } from "yaml";
import { GlobalConfigWriteError } from "./lotus-global-config-write.ts";

function invalid(): never {
  throw new GlobalConfigWriteError("config");
}

export interface SourceEdit {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

export type Pair = { key: string; flow: string; block: string[] };

export function sourceMappingPair(key: string, values: Map<unknown, unknown> | Readonly<Record<string, unknown>>): Pair {
  const flow = stringify(values, { collectionStyle: "flow", lineWidth: 0 }).trimEnd();
  const block = stringify(values, { lineWidth: 0 }).trimEnd().split("\n").map(line => `  ${line}`);
  return { key, flow, block: [`${key}:`, ...block] };
}

export function sourceAliasOverrides(text: string, node: Node, pairs: readonly Pair[]): SourceEdit {
  if (!isAlias(node) || !node.range) invalid();
  const [start, end] = node.range;
  const fields = pairs.map(({ key, flow }) => `${key}: ${flow}`).join(", ");
  return { start, end, value: `{<<: ${text.slice(start, end)}, ${fields}}` };
}

export function replaceSourceScalar(text: string, node: Node, replacement: string): SourceEdit {
  if (!node.range || (!isScalar(node) && !isAlias(node))) invalid();
  const [start, end] = node.range;
  const token = node.srcToken;
  if (token?.type === "block-scalar") {
    const header = token.props[0];
    if (header?.type !== "block-scalar-header") invalid();
    // Keep the block indicator's inline comment and line ending when replacing its body.
    replacement += text.slice(header.offset + header.source.length, end - token.source.length);
  }
  return { start, end, value: replacement };
}

export function insertSourcePairs(text: string, map: YAMLMap | undefined,
  pairs: readonly { readonly key: string; readonly flow: string; readonly block: readonly string[] }[]): SourceEdit {
  const token = map?.srcToken;
  if (map && token?.type === "flow-collection") {
    const start = token.start.offset + token.start.source.length;
    const value = pairs.map(pair => `${pair.key}: ${pair.flow}`).join(", ");
    return { start, end: start, value: map.items.length ? `${value}, ` : value };
  }

  if (map && (token?.type !== "block-map" || !map.range)) invalid();
  const indent = " ".repeat(token?.type === "block-map" ? token.indent : 0);
  const eol = /\r?\n/u.exec(text)?.[0] ?? "\n";
  const start = map?.range?.[1] ?? [...new Parser().parse(text)].find(item => item.type === "doc-end")?.offset ?? text.length;
  const before = text.slice(0, start);
  const prefix = !before || before === "\uFEFF" || before.endsWith("\n") ? "" : eol;
  const suffix = start === text.length && prefix ? "" : eol;
  const body = pairs.flatMap(pair => pair.block).map(line => indent + line).join(eol);
  return { start, end: start, value: prefix + body + suffix };
}
