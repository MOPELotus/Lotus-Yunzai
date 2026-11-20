import { isDeepStrictEqual } from "node:util";
import { isMap, parseDocument } from "yaml";
import { readLotusGlobalConfig } from "./lotus-global-config.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";

export type AtlasChannel = "live" | "latest";
type GlobalConfig = Readonly<Record<string, unknown>>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isAtlasChannel(value: unknown): value is AtlasChannel {
  return value === "live" || value === "latest";
}

function readChannel(config: GlobalConfig): AtlasChannel | null {
  const channel = record(config.atlas) ? config.atlas.version_channel : undefined;
  return isAtlasChannel(channel) ? channel : null;
}

function editChannel(text: string, local: GlobalConfig, effective: GlobalConfig, channel: AtlasChannel) {
  const document = parseDocument(text, { strict: true, uniqueKeys: true });
  if (document.errors.length || (document.contents && !isMap(document.contents))) {
    throw new GlobalConfigWriteError("config");
  }
  const atlas = effective.atlas === undefined ? {} : effective.atlas;
  if (!record(atlas)) throw new GlobalConfigWriteError("config");
  const next = { ...atlas, version_channel: channel };

  if (Object.hasOwn(local, "atlas")) {
    if (!isMap(document.get("atlas", true))) throw new GlobalConfigWriteError("config");
    document.setIn(["atlas", "version_channel"], channel);
  } else {
    // Preserve options from the effective old plugin when this first local Atlas section shadows it.
    document.set("atlas", next);
  }

  const yaml = document.toString({ lineWidth: 0 });
  if (!isDeepStrictEqual(Bun.YAML.parse(yaml), { ...local, atlas: next })) throw new GlobalConfigWriteError("config");
  return yaml;
}

export async function readAtlasChannel(root: URL): Promise<AtlasChannel | null> {
  return readChannel(await readLotusGlobalConfig(root));
}

export function persistAtlasChannel(root: URL, channel: AtlasChannel, previous: AtlasChannel | null, signal?: AbortSignal) {
  return updateLotusGlobalConfig(root, {
    canWrite: () => true,
    signal,
    prepare(content, local, effective) {
      const saved = readChannel(effective);
      if (saved !== previous) throw new GlobalConfigWriteError("conflict");
      return { yaml: channel === saved ? undefined : editChannel(content, local, effective, channel), value: channel };
    },
  });
}
