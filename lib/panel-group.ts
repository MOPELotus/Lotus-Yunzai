import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { lockFile } from "./file-lock.ts";
import { readPanelJson } from "./panel.ts";
import type { PluginLoadReport } from "./plugins/loader.ts";

type LikeSettingsModule = typeof import("../plugins/group/like-settings.ts");

type NoticeSettingsModule = typeof import("../plugins/group/group-notice-panel-settings.ts");

export function panelGroupNoticeSettings(root: URL, directories: PluginLoadReport["directories"]) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
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
    const active = () => !request.signal.aborted && stillAuthorized();
    const registered = () => directories.get("group") === group;
    try {
      return Response.json(await service.write(payload.revision, payload.patch, () => active() && registered()));
    } catch (error) {
      if (error instanceof module.GroupNoticePanelSettingsPermission) return new Response(null, { status: active() ? 409 : 401 });
      if (error instanceof module.GroupNoticePanelSettingsConflict) return new Response(null, { status: 409 });
      if (error instanceof module.GroupNoticePanelSettingsInputError) return new Response(null, { status: 400 });
      if (error instanceof module.GroupNoticePanelSettingsUnavailable) return new Response(null, { status: 503 });
      return new Response(null, { status: 500 });
    }
  };
}

export async function readGroupLikeSettingsModule(directories: PluginLoadReport["directories"]): Promise<LikeSettingsModule | undefined> {
  const group = directories.get("group");
  if (group?.packageName === "@lotus-yunzai/group") {
    return await import(pathToFileURL(join(group.path, "like-settings.ts")).href) as LikeSettingsModule;
  }
}

export function panelGroupSettings(directories: PluginLoadReport["directories"]) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const group = directories.get("group");
    if (!group || group.packageName !== "@lotus-yunzai/group") return new Response(null, { status: 404 });
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }

    let service: LikeSettingsModule;
    try {
      const module = await readGroupLikeSettingsModule(directories);
      if (!module) return new Response(null, { status: 404 });
      service = module;
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
    const active = () => !request.signal.aborted && stillAuthorized();
    const registered = () => directories.get("group") === group;
    try {
      return Response.json(await service.saveLikeSettings(payload.patch, {
        revision: payload.revision,
        canWrite: () => active() && registered(),
      }));
    } catch (error) {
      if (error instanceof service.LikeSettingsError) {
        return Response.json({ message: error.message }, { status: error.code === "conflict" ? (active() ? 409 : 401) : 400 });
      }
      return new Response(null, { status: 500 });
    }
  };
}
