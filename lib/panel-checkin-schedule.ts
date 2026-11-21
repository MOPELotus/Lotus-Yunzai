import { CheckinScheduleSettingsError, checkinSchedulePanelSnapshot, parseCheckinSchedulePanelPatch, persistCheckinSchedulePanelSettings } from "./checkin-schedule-settings.ts";
import { readLotusGlobalConfig } from "./lotus-global-config.ts";
import { GlobalConfigWriteError } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";

export function panelCheckinSchedule(root: URL) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method === "GET") {
      try { return Response.json(checkinSchedulePanelSnapshot((await readLotusGlobalConfig(root)).scheduler)); }
      catch { return new Response(null, { status: 500 }); }
    }
    if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });

    let revision: string;
    let patch: ReturnType<typeof parseCheckinSchedulePanelPatch>;
    try {
      const data = await readPanelJson(request, 4096);
      if (!data || typeof data !== "object" || Object.keys(data).length !== 2 ||
        !("revision" in data) || typeof data.revision !== "string" || !/^[a-f0-9]{64}$/u.test(data.revision) ||
        !("patch" in data)) throw new Error();
      revision = data.revision;
      patch = parseCheckinSchedulePanelPatch(data.patch);
    } catch {
      return new Response(null, { status: 400 });
    }

    try {
      return Response.json(await persistCheckinSchedulePanelSettings(root, revision, patch, {
        canWrite: stillAuthorized, signal: request.signal,
      }));
    } catch (error) {
      if (error instanceof CheckinScheduleSettingsError && error.reason === "invalid-input") {
        return Response.json({ message: "窗口结束时间不能早于开始时间。" }, { status: 422 });
      }
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" || reason === "cancelled" ? 401 : 500 });
    }
  };
}
