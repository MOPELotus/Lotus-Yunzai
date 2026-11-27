import { createTranslator } from "../packages/i18n/index.ts";
import catalog from "../i18n/zh-CN.json";
import { join } from "node:path";
import { createLocalGit, gitHead, type LocalGit } from "./local-git.ts";
import { sanitizeRuntimeLog } from "./runtime-logs.ts";
import type { ManagedUpdateProgress } from "./managed-update-protocol.ts";
const $t = createTranslator("core", catalog.messages);

export interface AppliedUpdateReport {
  readonly name: string;
  readonly date: string;
  readonly lines: readonly string[];
}

export async function readUpdateDate(directory: string, revision: string): Promise<string | undefined> {
  const git = createLocalGit();
  const value = (await git?.(directory, ["log", "-1", "--no-show-signature", "--date=format:%F %T", "--format=%cd", revision, "--"]))?.trim();
  return value && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value) ? value : undefined;
}

export async function reportCurrentUpdate(name: string, directory: string, revision: string,
  report?: (status: ManagedUpdateProgress) => void) {
  if (!report) return;
  const date = await readUpdateDate(directory, revision);
  report(date ? `dated:${name}:${date}` : `detail:${name}:current`);
}

async function pins(git: LocalGit, directory: string) {
  const result = await git(directory, ["ls-tree", "-r", "-z", "HEAD"]);
  return new Map((result ?? "").split("\0").flatMap(line => {
    const match = /^160000 commit ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)$/u.exec(line);
    return match ? [[match[2]!, match[1]!] as const] : [];
  }));
}

export async function readAppliedUpdateReports(previous: string, next: string, externalNames: readonly string[], signal?: AbortSignal) {
  const git = createLocalGit();
  if (!git) return [];
  const [oldPins, newPins] = await Promise.all([pins(git, previous), pins(git, next)]);
  const repositories = [{ name: "Lotus-Yunzai", source: previous, destination: next,
    before: await gitHead(git, previous), after: await gitHead(git, next) }];
  const paths = new Set([...newPins.keys(), ...externalNames.map(name => `plugins/${name}`)]);
  for (const path of paths) {
    signal?.throwIfAborted();
    if (!path.split("/").every(part => /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(part))) continue;
    const name = path.startsWith("plugins/") ? path.slice(8) : path.replaceAll("/", ".");
    const source = join(previous, path), destination = join(next, path);
    repositories.push({ name, source, destination, before: oldPins.get(path) ?? await gitHead(git, source),
      after: newPins.get(path) ?? await gitHead(git, destination) });
  }
  const reports: AppliedUpdateReport[] = [];
  let budget = 96 * 1024;
  for (const { name, source, destination, before, after } of repositories) {
    signal?.throwIfAborted();
    if (!after || before === after) continue;
    const date = await readUpdateDate(destination, after);
    if (!date) throw new Error($t("lib.update-report.read-failed"));
    let range = after;
    if (before) {
      if (await git(destination, ["cat-file", "-t", before]) === "commit\n") range = `${before}..${after}`;
      else if (await git(source, ["cat-file", "-t", after]) === "commit\n") {
        range = `${before}..${after}`;
      } else {
        reports.push({ name, date, lines: [] });
        continue;
      }
    }
    const logDirectory = before && await git(destination, ["cat-file", "-t", before]) !== "commit\n" ? source : destination;
    const raw = await git(logDirectory, ["log", "-z", "--no-color", "--no-decorate", "--no-show-signature", "--no-notes",
      "--max-count=100", "--date=format:%F %T", "--format=%cd%x00%s", range, "--"]);
    const fields = (raw ?? "").split("\0"), lines: string[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const title = sanitizeRuntimeLog(fields[index + 1]!, 500).trim();
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(fields[index]!) || !title || title.includes("Merge branch")) continue;
      const line = `[${fields[index]}] ${title}`;
      if (Buffer.byteLength(line) > budget) break;
      budget -= Buffer.byteLength(line);
      lines.push(line);
    }
    reports.push({ name, date, lines });
  }
  return reports;
}

export function describeAppliedUpdates(reports: readonly AppliedUpdateReport[]) {
  return reports.map(({ name, date }) => $t("lib.update-report.completed", { name, date })).join("\n\n");
}

export function appliedUpdateLogNodes(reports: readonly AppliedUpdateReport[]): string[] {
  return reports.flatMap(({ name, lines }) => {
    if (!lines.length) return [];
    const nodes = [$t("lib.update-report.title", { name, count: lines.length })];
    for (const line of lines) {
      const previous = nodes.length - 1;
      if (previous > 0 && Buffer.byteLength(nodes[previous]! + "\n\n" + line) <= 1200) nodes[previous] += "\n\n" + line;
      else nodes.push(line);
    }
    return nodes;
  });
}
