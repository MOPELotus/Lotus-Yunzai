import { isAtlasChannel, persistAtlasChannel, readAtlasChannel } from "./atlas-channel.ts";
import { GlobalConfigWriteError } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    if (!record(body) || Object.keys(body).length !== 2 || !isAtlasChannel(body.channel) ||
        (body.previous !== null && !isAtlasChannel(body.previous))) return new Response(null, { status: 400 });
    const { channel, previous } = body;
    try {
      return Response.json({ channel: await persistAtlasChannel(root, channel, previous, request.signal) });
    } catch (error) {
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : 500 });
    }
  };
}
