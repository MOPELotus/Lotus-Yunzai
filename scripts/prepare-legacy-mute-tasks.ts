import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeStorage, connectStorage } from "@lotus-yunzai/storage";
import { lockFile } from "../lib/file-lock.ts";
import { readStorageConnection } from "../lib/valkey-config.ts";
import { prepareLegacyMuteHandoff } from "../plugins/group/group-timed-mute.ts";

const legacyKey = "yenai:MuteTasks";
const snapshotLimit = 512 * 1024;
const compareAndApply = `
  local current = redis.call("GET", KEYS[1])
  if ARGV[1] == "missing" then
    if current then return -1 end
    return 0
  end
  if current == ARGV[3] then return 0 end
  if current ~= ARGV[2] then return -1 end
  if redis.call("SET", KEYS[1], ARGV[3], "XX", "KEEPTTL") then return 1 end
  return -1
`;

async function readSnapshot(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > snapshotLimit) throw new Error($t("scripts.prepare-legacy-mute-tasks.text_1687b02d10"));
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error($t("scripts.prepare-legacy-mute-tasks.text_9b85714183"));
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

async function applyHandoff(expected: string | null, value: string | null): Promise<boolean> {
  const directory = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  const base = join(dirname(directory), `.${basename(directory)}`);
  const startup = await lockFile(`${base}.lotus-startup.sqlite`, $t("scripts.prepare-legacy-mute-tasks.text_837c8d2798"), 0, $t("scripts.prepare-legacy-mute-tasks.text_0ae91b1d2b"));
  try {
    const host = await lockFile(`${base}.lotus-host.sqlite`, $t("scripts.prepare-legacy-mute-tasks.text_e533bb7ee6"), 0, $t("scripts.prepare-legacy-mute-tasks.text_4a72890a59"));
    try {
      const connection = await readStorageConnection(pathToFileURL(directory + sep), Bun.env.LOTUS_VALKEY_URL);
      if (!connection) throw new Error($t("scripts.prepare-legacy-mute-tasks.text_543f4d3ab6"));
      const redis = await connectStorage(connection);
      try {
        const result = await redis.eval(compareAndApply, {
          keys: [legacyKey], arguments: [expected === null ? "missing" : "present", expected ?? "", value ?? ""],
        });
        if (result === -1) throw new Error($t("scripts.prepare-legacy-mute-tasks.text_e0aa3546e9"));
        if (result !== 0 && result !== 1) throw new Error($t("scripts.prepare-legacy-mute-tasks.text_1e6219c02b"));
        return result === 1;
      } finally {
        await closeStorage();
      }
    } finally {
      host.close();
    }
  } finally {
    startup.close();
  }
}

const args = process.argv.slice(2);
const apply = args[0] === "--apply";
const [modern, previous, ...extra] = apply ? args.slice(1) : args;
if (!modern || !previous || extra.length || modern.startsWith("--") || previous.startsWith("--")) {
  console.error($t("scripts.prepare-legacy-mute-tasks.text_efe1963515"));
  process.exit(2);
}

try {
  const [state, snapshot] = await Promise.all([readSnapshot(modern), readSnapshot(previous)]);
  let expected: string | null;
  let prepared: ReturnType<typeof prepareLegacyMuteHandoff>;
  try {
    expected = snapshot.length ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot) : null;
    prepared = prepareLegacyMuteHandoff(state, expected);
  } catch {
    throw new Error($t("scripts.prepare-legacy-mute-tasks.text_a407c37c0d"));
  }
  const changed = apply ? await applyHandoff(expected, prepared.value) : false;
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", removed: prepared.removed, changed }));
} catch (error) {
  console.error(error instanceof Error && !("code" in error) ? error.message : $t("scripts.prepare-legacy-mute-tasks.text_379acb4e1a"));
  process.exitCode = 1;
}
