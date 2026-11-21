import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { legacyLotusDirectories, resolveLotusGlobalConfig } from "./lotus-global-config.ts";
import { projectLegacyMediaConfig } from "./migration-media-config.ts";

type Config = Record<string, unknown>;

function projectSettings(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, (value as Config)[key]]));
}

const supported = {
  scheduler: ["enable", "run_due_cron", "plan_generate_cron", "catch_up_cron", "mode", "fixed_time", "random", "late_registration"],
  permissions: ["default_policy", "users", "groups", "scopes"],
  coin_shop: ["enable", "path", "public_url", "ticket_minutes", "session_hours", "panel_ticket_minutes", "panel_session_hours"],
  daily_note_reminders: ["enable"],
} as const;

async function readGlobal(root: string, prefix: string): Promise<Config | undefined> {
  for (const local of ["config/global.yaml", "config/config/global.yaml"]) {
    const path = join(root, prefix, local);
    const visible = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!visible) continue;
    if (!visible.isFile() || visible.nlink !== 1 || visible.size > 256 * 1024 || await realpath(path) !== path) {
      throw new Error("旧全局配置须为副本中的普通 YAML 文件。");
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const first = await file.stat();
      const same = (info: typeof first) => info.dev === visible.dev && info.ino === visible.ino &&
        info.nlink === visible.nlink && info.size === visible.size && info.ctimeMs === visible.ctimeMs;
      if (!same(first)) throw new Error("旧全局配置在迁移期间发生变化。");
      const bytes = Buffer.alloc(first.size);
      for (let offset = 0; offset < bytes.length;) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error("旧全局配置在迁移期间发生变化。");
        offset += bytesRead;
      }
      if (!same(await file.stat()) || !same(await lstat(path)) || await realpath(path) !== path) {
        throw new Error("旧全局配置在迁移期间发生变化。");
      }
      try {
        const config: unknown = Bun.YAML.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (config === null || config === undefined) return {};
        if (typeof config === "object" && !Array.isArray(config)) return config as Config;
      } catch {}
      throw new Error("旧全局配置须为有效的 YAML 映射。");
    } finally {
      await file.close();
    }
  }
}

/** Materialize settings whose running consumers previously reached into rejected plugin directories. */
export async function stageLegacyGlobalConfig(source: string, stage: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const [local, ...legacy] = await Promise.all([readGlobal(source, ""),
    ...legacyLotusDirectories.map(id => readGlobal(source, `plugins/${id}`))]);
  const effective = await resolveLotusGlobalConfig(local ?? {}, async id => legacy[legacyLotusDirectories.indexOf(id)]);
  const media = projectLegacyMediaConfig(local ?? {}, legacy.filter((config): config is Config => config !== undefined));
  const projected: Config = { ...media.config };
  for (const [key, fields] of Object.entries(supported)) {
    if (Object.hasOwn(effective, key)) projected[key] = projectSettings(effective[key], fields);
  }
  const sections = Object.keys(projected);
  signal?.throwIfAborted();
  if (sections.length) {
    const directory = join(stage, "config");
    await mkdir(directory, { mode: 0o700, recursive: true });
    if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) {
      throw new Error("全局配置暂存路径须为实体目录。");
    }
    await writeFile(join(directory, "global.yaml"), Bun.YAML.stringify(projected), { flag: "wx", mode: 0o600 });
  }
  return { sections, deferredMedia: media.deferred };
}
