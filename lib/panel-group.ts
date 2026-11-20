import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { lockFile } from "./file-lock.ts";
import { readPanelJson } from "./panel.ts";
import type { PluginLoadReport } from "./plugins/loader.ts";

interface LikeSettingsModule {
  readLikeSettings(): Promise<unknown>;
  saveLikeSettings(patch: unknown, options: { revision: string }): Promise<unknown>;
  LikeSettingsError: new (...args: never[]) => Error & { code: "invalid" | "conflict" };
}

type NoticeSettingsModule = typeof import("../plugins/group/group-notice-panel-settings.ts");

export function panelGroupNoticeSettings(root: URL, directories: PluginLoadReport["directories"]) {
  return async (request: Request): Promise<Response> => {
    const group = directories.get("group");
    if (!group || group.packageName !== "@lotus-yunzai/group") return new Response(null, { status: 404 });
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }

    let module: NoticeSettingsModule;
    try {
      module = await import(pathToFileURL(join(group.path, "group-notice-panel-settings.ts")).href) as NoticeSettingsModule;
    } catch {
      return new Response(null, { status: 500 });
    }

    const service = module.createGroupNoticePanelSettings(root, lockFile);
    if (request.method === "GET") {
      try { return Response.json(await service.read()); }
      catch { return new Response(null, { status: 500 }); }
    }

    let payload: unknown;
    try { payload = await readPanelJson(request); }
    catch { return new Response(null, { status: 400 }); }
    if (!payload || typeof payload !== "object" || !("revision" in payload) || !("patch" in payload) ||
        typeof payload.revision !== "string" || Object.keys(payload).length !== 2) {
      return new Response(null, { status: 400 });
    }
    try {
      return Response.json(await service.write(payload.revision, payload.patch));
    } catch (error) {
      if (error instanceof module.GroupNoticePanelSettingsConflict) return new Response(null, { status: 409 });
      if (error instanceof module.GroupNoticePanelSettingsInputError) return new Response(null, { status: 400 });
      if (error instanceof module.GroupNoticePanelSettingsUnavailable) return new Response(null, { status: 503 });
      return new Response(null, { status: 500 });
    }
  };
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
