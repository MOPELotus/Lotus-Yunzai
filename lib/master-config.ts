import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { constants, renameSync } from "node:fs";
import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isMap, isNode, isScalar, isSeq, parseDocument, type Node } from "yaml";
import { lockFile } from "./file-lock.ts";
import { configuredIds } from "./config.ts";
import { defaultPrivateAccessMessage, privateAccessPatterns, privateAccessPolicy } from "./private-access.ts";
import { readRequestOtherPolicyFiles, requestAutomationSettings, type OtherPolicyFiles } from "./request-other-policies.ts";

const ownerFields = new Set(["master", "masterQQ"]);
const ownerPair = /^(?:stdin:stdin|[1-9]\d*:[1-9]\d*)$/u;

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function valuesOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

async function effectiveFile(root: URL): Promise<string> {
  for (const path of ["config/other.yaml", "config/config/other.yaml"]) {
    const source = new URL(path, root);
    if (!await Bun.file(source).exists()) continue;
    try {
      return await realpath(fileURLToPath(source));
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
  }
  throw new Error($t("lib.master-config.text_6009ff8931"));
}

async function readSnapshot(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error($t("lib.master-config.text_8930ae6797"));
    return { stat, bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

function readDocument(text: string) {
  try {
    const document = parseDocument(text, { merge: true, strict: true, uniqueKeys: true });
    if (document.errors.length) throw new Error();
    const values: unknown = document.toJS({ mapAsMap: true });
    const runtime: unknown = Bun.YAML.parse(text);
    if (!(values instanceof Map) || typeof runtime !== "object" || runtime === null || Array.isArray(runtime)) {
      throw new Error();
    }
    const config = runtime as Record<string, unknown>;
    if ([...ownerFields].some((key) => !isDeepStrictEqual(values.get(key), config[key]))) throw new Error();
    return { document, values: values as Map<unknown, unknown>, config, text };
  } catch {
    throw new Error($t("lib.master-config.text_bf3bf51eb8"));
  }
}

function append(document: ReturnType<typeof readDocument>["document"], key: string, current: unknown[], entry: string | number) {
  const node = document.get(key, true);
  if (isSeq(node)) {
    node.add(entry);
    return;
  }

  const sequence = document.createNode([...current, entry]);
  if (isScalar(node) && current.length === 1) {
    sequence.items[0] = node;
  } else if (isNode(node)) {
    sequence.comment = node.comment;
    sequence.commentBefore = node.commentBefore;
    sequence.spaceBefore = node.spaceBefore;
  }
  document.set(key, sequence);
}

function unknownFields(values: Map<unknown, unknown>) {
  return new Map([...values].filter(([key]) => typeof key !== "string" || !ownerFields.has(key)));
}

async function editOtherConfig<T>(
  root: URL,
  mutate: (current: ReturnType<typeof readDocument>) => { result: T; yaml?: string } | Promise<{ result: T; yaml?: string }>,
  isCurrent?: () => boolean,
): Promise<T> {
  const file = await effectiveFile(root);
  const database = await lockFile(join(dirname(file), `.${basename(file)}.lotus-master.sqlite`), "other.yaml");
  try {
    if (await effectiveFile(root) !== file) throw new Error($t("lib.master-config.text_6055e445f4"));
    const current = await readSnapshot(file);
    if (isCurrent && !isCurrent()) throw new Error($t("lib.master-config.text_06ca515d7e"));
    const edit = await mutate(readDocument(current.bytes.toString("utf8")));
    const { yaml } = edit;
    if (yaml === undefined) return edit.result;
    const directory = await mkdtemp(join(dirname(file), ".lotus-master-"));
    try {
      const staged = join(directory, "other.yaml");
      const output = await open(staged, "wx", 0o600);
      try {
        await output.writeFile(yaml, "utf8");
        const owner = await output.stat();
        if (owner.uid !== current.stat.uid || owner.gid !== current.stat.gid) {
          await output.chown(current.stat.uid, current.stat.gid);
        }
        await output.chmod(current.stat.mode & 0o7777);
        await output.sync();
      } finally {
        await output.close();
      }

      if (await effectiveFile(root) !== file) throw new Error($t("lib.master-config.text_6055e445f4"));
      const latest = await readSnapshot(file);
      if (current.stat.ino !== latest.stat.ino || current.stat.dev !== latest.stat.dev ||
          current.stat.mode !== latest.stat.mode || current.stat.uid !== latest.stat.uid ||
          current.stat.gid !== latest.stat.gid || !current.bytes.equals(latest.bytes)) {
        throw new Error($t("lib.master-config.text_37bf3232ec"));
      }
      // Keep the final session check and config replacement in the same event-loop turn.
      if (isCurrent && !isCurrent()) throw new Error($t("lib.master-config.text_06ca515d7e"));
      renameSync(staged, file);
      return edit.result;
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  } finally {
    database.close();
  }
}

export async function persistMaster(
  root: URL, bot: number, user: number, approver: number | "stdin", isCurrent?: () => boolean,
): Promise<Record<string, unknown>> {
  if (!isId(bot) || !isId(user) || (approver !== "stdin" && !isId(approver))) {
    throw new Error($t("lib.master-config.text_79e8ffbcd2"));
  }

  return editOtherConfig(root, ({ document, values, config }) => {
    const masters = valuesOf(config.master);
    if (!masters.every((entry) => typeof entry === "string" && ownerPair.test(entry.trim()))) {
      throw new Error($t("lib.master-config.text_4cffc90bd3"));
    }
    const authorization = approver === "stdin" ? "stdin:stdin" : `${bot}:${approver}`;
    if (!masters.some((entry) => typeof entry === "string" && entry.trim() === authorization)) {
      throw new Error($t("lib.master-config.text_4dd06df728"));
    }

    const owner = `${bot}:${user}`;
    const legacy = valuesOf(config.masterQQ);
    const alreadyMaster = masters.some((entry) => typeof entry === "string" && entry.trim() === owner);
    const alreadyLegacy = legacy.some((entry) => entry === user ||
      (typeof entry === "string" && /^\d+$/u.test(entry.trim()) && Number(entry) === user));
    if (alreadyMaster && alreadyLegacy) return { result: config };
    if (!alreadyMaster) append(document, "master", masters, owner);
    if (!alreadyLegacy) append(document, "masterQQ", legacy, user);

    const yaml = document.toString();
    const next = readDocument(yaml);
    if (!isDeepStrictEqual(unknownFields(values), unknownFields(next.values)) ||
        !isDeepStrictEqual(valuesOf(next.config.master), alreadyMaster ? masters : [...masters, owner]) ||
        !isDeepStrictEqual(valuesOf(next.config.masterQQ), alreadyLegacy ? legacy : [...legacy, user])) {
      throw new Error($t("lib.master-config.text_b1de7c1510"));
    }

    return { result: next.config, yaml };
  }, isCurrent);
}

function configuredId(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value) : value;
  return isId(number) ? number : undefined;
}

export type HostAccessList = "blackUser" | "whiteUser" | "blackGroup" | "whiteGroup";
type Added = "added" | "existing" | "protected";
type ListResult = Added | "removed" | "missing";

function replaceListText(text: string, oldNode: Node | undefined, document: ReturnType<typeof readDocument>["document"], key: HostAccessList) {
  const rendered = document.toString();
  const nextNode = parseDocument(rendered).get(key, true);
  if (!isSeq(nextNode) || !nextNode.range) throw new Error($t("lib.master-config.text_9c92156a62"));
  const [newStart, newEnd] = nextNode.range;
  const value = rendered.slice(newStart, newEnd);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (oldNode?.range) {
    const [start, end] = oldNode.range;
    const oldIndent = start - text.lastIndexOf("\n", start - 1) - 1;
    const newIndent = newStart - rendered.lastIndexOf("\n", newStart - 1) - 1;
    const aligned = value.split("\n").map((line, index) => {
      if (index === 0 || !line) return line;
      return " ".repeat(oldIndent) + line.slice(newIndent);
    }).join(eol);
    const before = start === end && text[start - 1] === ":" ? " " : "";
    const after = start === end && text[start] === "#" ? " "
      : text.slice(start, end).endsWith("\n") && !aligned.endsWith("\n") ? eol : "";
    return text.slice(0, start) + before + aligned + after + text.slice(end);
  }
  const body = document.contents;
  if (!isMap(body) || !body.range) return rendered;
  const [start, end] = body.range;
  if (body.flow && text[start] === "{") {
    return text.slice(0, start + 1) + `${key}: ${value}, ` + text.slice(start + 1);
  }
  const before = text.slice(0, end);
  const newline = before && !before.endsWith("\n") ? eol : "";
  const indentation = " ".repeat(start - text.lastIndexOf("\n", start - 1) - 1);
  return before + newline + indentation + `${key}: ${value}${eol}` + text.slice(end);
}

function editAccessList(root: URL, key: HostAccessList, target: number, remove: false,
  isCurrent: () => boolean, owner?: string): Promise<Added>;
function editAccessList(root: URL, key: HostAccessList, target: number, remove: boolean,
  isCurrent: () => boolean, owner?: string): Promise<ListResult>;
function editAccessList(root: URL, key: HostAccessList, target: number, remove: boolean,
  isCurrent: () => boolean, owner?: string): Promise<ListResult> {
  if (!isId(target)) throw new Error($t("lib.master-config.text_2ffc298e74"));
  return editOtherConfig<ListResult>(root, ({ document, values, config, text }) => {
    if (owner && !valuesOf(config.master).some(entry => typeof entry === "string" && entry.trim() === owner)) {
      throw new Error($t("lib.master-config.text_4dd06df728"));
    }
    if (key === "blackUser" && !remove && (valuesOf(config.masterQQ).some(entry => configuredId(entry) === target) ||
        valuesOf(config.master).some(entry => typeof entry === "string" && ownerPair.test(entry.trim()) &&
          entry.trim().endsWith(`:${target}`)))) {
      return { result: "protected" };
    }

    const entries = valuesOf(config[key]);
    if (!isDeepStrictEqual(values.get(key), config[key]) ||
        !entries.every(entry => configuredId(entry) !== undefined)) {
      throw new Error($t("lib.master-config.text_cb26b281db", { "key": key }));
    }
    const remaining = entries.filter(entry => configuredId(entry) !== target);
    if (remove && remaining.length === entries.length) return { result: "missing" };
    if (!remove && remaining.length !== entries.length) return { result: "existing" };

    const node = document.get(key, true);
    if (remove) {
      if (isSeq(node)) {
        for (let position = entries.length - 1; position >= 0; position--) {
          if (configuredId(entries[position]) === target) node.delete(position);
        }
      } else if (isScalar(node) && !node.anchor) {
        const sequence = document.createNode([]);
        sequence.comment = node.comment;
        sequence.commentBefore = node.commentBefore;
        sequence.spaceBefore = node.spaceBefore;
        document.set(key, sequence);
      } else {
        throw new Error($t("lib.master-config.text_48a6298fc3"));
      }
    } else {
      append(document, key, entries, target);
    }
    const destination = document.get(key, true);
    if (isSeq(destination) && !isSeq(node)) destination.flow = true;
    const yaml = replaceListText(text, isNode(node) ? node : undefined, document, key);
    const next = readDocument(yaml);
    const otherFields = (map: Map<unknown, unknown>) => new Map([...map].filter(([name]) => name !== key));
    if (!isDeepStrictEqual(otherFields(values), otherFields(next.values)) ||
        !isDeepStrictEqual(next.values.get(key), next.config[key]) ||
        !isDeepStrictEqual(next.config[key], remove ? remaining : [...entries, target])) {
      throw new Error($t("lib.master-config.text_96e359181a"));
    }
    return { result: remove ? "removed" : "added", yaml };
  }, isCurrent);
}

export function appendBlackUser(root: URL, user: number, isCurrent: () => boolean) {
  return editAccessList(root, "blackUser", user, false, isCurrent);
}

export function updateHostAccessList(root: URL, key: HostAccessList, target: number, remove: boolean,
  actor: { botId: number; userId: number } | "stdin", isCurrent: () => boolean) {
  if (actor !== "stdin" && (!isId(actor.botId) || !isId(actor.userId))) throw new Error($t("lib.master-config.text_2a04f8e58b"));
  const owner = actor === "stdin" ? "stdin:stdin" : `${actor.botId}:${actor.userId}`;
  return editAccessList(root, key, target, remove, isCurrent, owner);
}

export const hostIngressListKeys = ["whiteUser", "blackUser", "whiteGroup", "blackGroup"] as const;
export const hostIngressKeys = [...hostIngressListKeys, "disablePrivate", "disableMsg", "disableAdopt", "autoFriend", "autoGroup", "autoQuit"] as const;

export function hostIngressSettings(files: OtherPolicyFiles) {
  const config = files[0] ?? files[1] ?? {};
  const ids = (key: HostAccessList) => [...configuredIds(config[key])].map(String);
  return {
    whiteUser: ids("whiteUser"), blackUser: ids("blackUser"), whiteGroup: ids("whiteGroup"), blackGroup: ids("blackGroup"),
    disablePrivate: Boolean(config.disablePrivate),
    disableMsg: typeof config.disableMsg === "string" ? config.disableMsg : defaultPrivateAccessMessage,
    disableAdopt: privateAccessPatterns(config),
    ...requestAutomationSettings(files),
  };
}

export type HostIngressSettings = ReturnType<typeof hostIngressSettings>;

export class HostIngressSettingsError extends Error {
  constructor(readonly code: "conflict" | "invalid", message: string) { super(message); }
}

export function saveHostIngressSettings(root: URL, previous: HostIngressSettings, next: HostIngressSettings, isCurrent: () => boolean) {
  return editOtherConfig(root, async ({ document, values, config, text }) => {
    const files = await readRequestOtherPolicyFiles(root);
    const legacy = files[0] === undefined && files[1] !== undefined;
    const withEditedConfig = (changed: Readonly<Record<string, unknown>>): OtherPolicyFiles =>
      legacy ? [undefined, changed] : [changed, files[1]];
    if (!isDeepStrictEqual(files[0] ?? files[1], config)) throw new HostIngressSettingsError("conflict", $t("lib.master-config.text_25e15da9b2"));
    const current = hostIngressSettings(files);
    if (!isDeepStrictEqual(current, previous)) throw new HostIngressSettingsError("conflict", $t("lib.master-config.text_25e15da9b2"));
    if (legacy && next.autoGroup === "off") {
      throw new HostIngressSettingsError("invalid", $t("lib.master-config.text_f3ac6a4040"));
    }
    const blocked = next.blackUser.filter(id => !current.blackUser.includes(id));
    if (blocked.length && (
      [...configuredIds(config.masterQQ)].some(id => blocked.includes(String(id))) ||
      valuesOf(config.master).some(entry => typeof entry === "string" && ownerPair.test(entry.trim()) &&
        blocked.some(id => entry.trim().endsWith(`:${id}`)))
    )) throw new HostIngressSettingsError("invalid", $t("lib.master-config.text_4dc8e6c941"));

    const changed = hostIngressKeys.filter(key => !isDeepStrictEqual(current[key], next[key]));
    if (!changed.length) return { result: { values: current, legacy } };
    for (const key of changed) {
      const value = key === "autoFriend" ? Number(next.autoFriend) :
        key === "autoGroup" ? { all: 1, owners: 0, off: false }[next.autoGroup] : next[key];
      const original = document.get(key, true);
      const replacement = document.createNode(Array.isArray(value) && key !== "disableAdopt" ? value.map(Number) : value);
      if (isNode(original)) {
        replacement.comment = original.comment;
        replacement.commentBefore = original.commentBefore;
        replacement.spaceBefore = original.spaceBefore;
        if (isSeq(original) && isSeq(replacement)) replacement.flow = original.flow;
      }
      document.set(key, replacement);
    }
    const formatted = document.toString();
    const yaml = text.includes("\r\n") ? formatted.replaceAll("\n", "\r\n") : formatted;
    const saved = readDocument(yaml);
    const belongsToOtherFields = (key: unknown) => !changed.some(changedKey => changedKey === key);
    const untouched = (map: Map<unknown, unknown>) => new Map([...map].filter(([key]) => belongsToOtherFields(key)));
    const runtime = (input: Record<string, unknown>) => Object.fromEntries(Object.entries(input).filter(([key]) => belongsToOtherFields(key)));
    if (!isDeepStrictEqual(untouched(values), untouched(saved.values)) ||
        !isDeepStrictEqual(runtime(config), runtime(saved.config)) ||
        !isDeepStrictEqual(hostIngressSettings(withEditedConfig(saved.config)), next)) {
      throw new Error($t("lib.master-config.text_a3440b0dc2"));
    }
    const changedPatterns = changed.includes("disableAdopt");
    if (changedPatterns || changed.includes("disablePrivate")) {
      try { privateAccessPolicy(changedPatterns ? { ...saved.config, disablePrivate: true } : saved.config); }
      catch { throw new HostIngressSettingsError("invalid", $t("lib.master-config.text_f78286ecaf")); }
    }
    return { result: { values: next, legacy }, yaml };
  }, isCurrent);
}
