import { constants, renameSync } from "node:fs";
import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isNode, isScalar, isSeq, parseDocument } from "yaml";
import { lockFile } from "./file-lock.ts";

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
  throw new Error("请先在本机配置 other.yaml 并设置主人授权。");
}

async function readSnapshot(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("主人配置须为普通 YAML 文件。");
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
    return { document, values: values as Map<unknown, unknown>, config };
  } catch {
    throw new Error("主人配置的 YAML 无效。");
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

export async function persistMaster(
  root: URL, bot: number, user: number, approver: number | "stdin", isCurrent?: () => boolean,
): Promise<Record<string, unknown>> {
  if (!isId(bot) || !isId(user) || (approver !== "stdin" && !isId(approver))) {
    throw new Error("主人授权须指定有效的机器人与 QQ 账号。");
  }

  const file = await effectiveFile(root);
  const database = await lockFile(join(dirname(file), `.${basename(file)}.lotus-master.sqlite`), "主人配置");
  try {
    if (await effectiveFile(root) !== file) throw new Error("主人配置位置已变更，请重新发起授权。");
    const current = await readSnapshot(file);
    const { document, values, config } = readDocument(current.bytes.toString("utf8"));
    const masters = valuesOf(config.master);
    if (!masters.every((entry) => typeof entry === "string" && ownerPair.test(entry.trim()))) {
      throw new Error("主人配置包含无效账号绑定。");
    }
    const authorization = approver === "stdin" ? "stdin:stdin" : `${bot}:${approver}`;
    if (!masters.some((entry) => typeof entry === "string" && entry.trim() === authorization)) {
      throw new Error("当前操作者未获得这台机器人的主人授权。");
    }

    const owner = `${bot}:${user}`;
    const legacy = valuesOf(config.masterQQ);
    const alreadyMaster = masters.some((entry) => typeof entry === "string" && entry.trim() === owner);
    const alreadyLegacy = legacy.some((entry) => entry === user ||
      (typeof entry === "string" && /^\d+$/u.test(entry.trim()) && Number(entry) === user));
    if (isCurrent && !isCurrent()) throw new Error("主人授权会话已失效，请重新申请。");
    if (alreadyMaster && alreadyLegacy) return config;
    if (!alreadyMaster) append(document, "master", masters, owner);
    if (!alreadyLegacy) append(document, "masterQQ", legacy, user);

    const yaml = document.toString();
    const next = readDocument(yaml);
    if (!isDeepStrictEqual(unknownFields(values), unknownFields(next.values)) ||
        !isDeepStrictEqual(valuesOf(next.config.master), alreadyMaster ? masters : [...masters, owner]) ||
        !isDeepStrictEqual(valuesOf(next.config.masterQQ), alreadyLegacy ? legacy : [...legacy, user])) {
      throw new Error("写入主人配置将改变其他 YAML 字段或引用。");
    }

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

      if (await effectiveFile(root) !== file) throw new Error("主人配置位置已变更，请重新发起授权。");
      const latest = await readSnapshot(file);
      if (current.stat.ino !== latest.stat.ino || current.stat.dev !== latest.stat.dev ||
          current.stat.mode !== latest.stat.mode || current.stat.uid !== latest.stat.uid ||
          current.stat.gid !== latest.stat.gid || !current.bytes.equals(latest.bytes)) {
        throw new Error("主人配置已变更，请重新发起授权。");
      }
      // Keep the final session check and config replacement in the same event-loop turn.
      if (isCurrent && !isCurrent()) throw new Error("主人授权会话已失效，请重新申请。");
      renameSync(staged, file);
      return next.config;
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  } finally {
    database.close();
  }
}
