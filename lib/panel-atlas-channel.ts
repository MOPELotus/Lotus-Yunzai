import { isDeepStrictEqual } from "node:util";
import { isMap, parseDocument } from "yaml";
import { readLotusGlobalConfig } from "./lotus-global-config.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";

type Channel = "live" | "latest";
type GlobalConfig = Readonly<Record<string, unknown>>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isChannel(value: unknown): value is Channel {
  return value === "live" || value === "latest";
}

function readChannel(config: GlobalConfig): Channel | null {
  const channel = record(config.atlas) ? config.atlas.version_channel : undefined;
  return isChannel(channel) ? channel : null;
}

function editChannel(text: string, local: GlobalConfig, effective: GlobalConfig, channel: Channel) {
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

export async function readAtlasChannel(root: URL): Promise<Channel | null> {
  return readChannel(await readLotusGlobalConfig(root));
}

export function persistAtlasChannel(root: URL, channel: Channel, previous: Channel | null, signal?: AbortSignal) {
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

export function panelAtlasChannel(root: URL) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "GET") {
      try { return Response.json({ channel: await readAtlasChannel(root) }); }
      catch { return new Response(null, { status: 500 }); }
    }
    if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });

    let body: unknown;
    try { body = await readPanelJson(request); }
    catch { return new Response(null, { status: 400 }); }
    if (!record(body) || Object.keys(body).length !== 2 || !isChannel(body.channel) ||
        (body.previous !== null && !isChannel(body.previous))) return new Response(null, { status: 400 });
    const { channel, previous } = body;
    try {
      return Response.json({ channel: await persistAtlasChannel(root, channel, previous, request.signal) });
    } catch (error) {
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : 500 });
    }
  };
}
