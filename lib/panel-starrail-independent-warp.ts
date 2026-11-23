import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { lockFile } from "./file-lock.ts";
import { readPanelJson } from "./panel.ts";

const fields = [
  { key: "enabled", label: "对旧十连指令使用独立规则", type: "boolean",
    hint: "启用后，旧抽卡与十连按群或私聊独立计数。单抽、多连和指定编号的指令继续使用星轨票。" },
  { key: "group", label: "允许群聊", type: "boolean" },
  { key: "private", label: "允许私聊", type: "boolean" },
  { key: "dailyTenPulls", label: "每日每池的十连次数", type: "number", min: 0,
    hint: "填 0 为不限。主人不受次数限制。" },
  { key: "disabledGroups", label: "禁用群号", type: "list", separator: "line" },
  { key: "recallSeconds", label: "未中五星时撤回延时（秒）", type: "number", min: 0, max: 2_147_483,
    hint: "填 0 不撤回。" },
] as const;

class SettingsConflict extends Error {}

export function panelStarRailIndependentWarp(root: URL) {
  const directory = fileURLToPath(new URL("data/starrail/simulation/", root));
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    const verify = async () => { if (!active()) throw new Error("管理会话已失效。"); };
    if (!active()) return new Response(null, { status: 401 });
    if (request.method !== "GET" && request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    try {
      const { createIndependentWarpSettingsStore, parseIndependentWarpSettings } =
        await import("../plugins/starrail/simulation/independent-settings.ts");
      const store = createIndependentWarpSettingsStore(lockFile, Bun.env.LOTUS_STAR_RAIL_WARP_STATE_DIR?.trim() || directory);
      if (request.method === "GET") {
        const values = await store.read();
        await verify();
        return Response.json({ fields, values });
      }
      let next, previous;
      try {
        const body = await readPanelJson(request, 128 * 1024) as { values?: unknown; previous?: unknown };
        next = parseIndependentWarpSettings(body.values);
        previous = parseIndependentWarpSettings(body.previous);
      } catch {
        return Response.json({ message: "请检查星铁旧十连配置、数字和群号。" }, { status: 400 });
      }
      const saved = await store.update(current => {
        if (!isDeepStrictEqual(current, previous)) throw new SettingsConflict("星铁旧十连设置已更改。");
        return next;
      }, verify);
      return Response.json({ fields, values: saved });
    } catch (error) {
      if (!active()) return new Response(null, { status: 401 });
      if (error instanceof SettingsConflict) return Response.json({ message: error.message }, { status: 409 });
      return new Response(null, { status: 500 });
    }
  };
}
