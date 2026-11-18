import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readPanelJson } from "./panel.ts";
import type { PluginLoadReport } from "./plugins/loader.ts";

interface LikeSettingsModule {
  readLikeSettings(): Promise<unknown>;
  saveLikeSettings(patch: unknown, options: { revision: string }): Promise<unknown>;
  LikeSettingsError: new (...args: never[]) => Error & { code: "invalid" | "conflict" };
}

export function panelGroupSettings(directories: PluginLoadReport["directories"]) {
  return async (request: Request): Promise<Response> => {
    const group = directories.get("group");
    if (!group || group.packageName !== "@lotus-yunzai/group") return new Response(null, { status: 404 });
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }

    let service: LikeSettingsModule;
    try {
      service = await import(pathToFileURL(join(group.path, "like-settings.ts")).href) as LikeSettingsModule;
    } catch {
      return new Response(null, { status: 500 });
    }

    if (request.method === "GET") {
      try {
        return Response.json(await service.readLikeSettings());
      } catch {
        return new Response(null, { status: 500 });
      }
    }

    let payload: unknown;
    try {
      payload = await readPanelJson(request);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (typeof payload !== "object" || payload === null || !("patch" in payload) ||
        !("revision" in payload) || typeof payload.revision !== "string") {
      return new Response(null, { status: 400 });
    }
    try {
      return Response.json(await service.saveLikeSettings(payload.patch, { revision: payload.revision }));
    } catch (error) {
      if (error instanceof service.LikeSettingsError) {
        return Response.json({ message: error.message }, { status: error.code === "conflict" ? 409 : 400 });
      }
      return new Response(null, { status: 500 });
    }
  };
}
