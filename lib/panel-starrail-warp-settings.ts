import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { WarpSettings } from "../plugins/starrail/simulation/settings.ts";
import { lockFile } from "./file-lock.ts";
import { readPanelJson } from "./panel.ts";

const allowanceKeys = ["special", "regular", "recallSeconds"] as const;
const rateKeys = ["characterFive", "characterFour", "coneFive", "coneFour", "featuredFive"] as const;
const poolKeys = ["characterFive", "characterFour", "coneFive", "coneFour"] as const;
const fields = [
  { key: "enabled", label: "启用星铁模拟跃迁", type: "boolean" },
  { key: "multiple", label: "允许单次超过十连", type: "boolean" },
  { key: "weeklyBonus", label: "启用每周双黄", type: "boolean",
    hint: "本周在当前会话恰好抽到一个五星后，五星基础概率翻倍。联动池不参与。" },
  { key: "automaticPools", label: "使用自动轮换卡池", type: "boolean",
    hint: "开启时手工卡池名单仍会保存，关闭自动轮换后生效。" },
  { key: "reincarnationMinutes", label: "转生冷却（分钟）", type: "number", min: 1, max: 1440 },
  { key: "special", label: "每日专票数", type: "number", min: 0, max: 10_000, hint: "填 0 时当日首次领取不发这一种票。" },
  { key: "regular", label: "每日通票数", type: "number", min: 0, max: 10_000, hint: "填 0 时当日首次领取不发这一种票。" },
  { key: "recallSeconds", label: "结果图撤回延时（秒）", type: "number", min: 0, max: 120, hint: "填 0 不撤回。" },
  { key: "groups", label: "按群覆盖", type: "json" },
  { key: "characterFive", label: "角色池五星基础概率（万分比）", type: "number", min: 0, max: 10_000 },
  { key: "characterFour", label: "角色池四星基础概率（万分比）", type: "number", min: 0, max: 10_000 },
  { key: "coneFive", label: "光锥池五星基础概率（万分比）", type: "number", min: 0, max: 10_000 },
  { key: "coneFour", label: "光锥池四星基础概率（万分比）", type: "number", min: 0, max: 10_000 },
  { key: "featuredFive", label: "五星小保底命中率（百分比）", type: "number", min: 0, max: 100, nullable: true,
    hint: "留空时角色池为 50%，光锥池为 75%。" },
  { key: "poolCharacterFive", label: "手工五星角色名单", type: "list", separator: "line", hint: "每行一名，最多 4 名。" },
  { key: "poolCharacterFour", label: "手工四星角色名单", type: "list", separator: "line", hint: "每行一名，最多 20 名。" },
  { key: "poolConeFive", label: "手工五星光锥名单", type: "list", separator: "line", hint: "每行一项，最多 4 项。" },
  { key: "poolConeFour", label: "手工四星光锥名单", type: "list", separator: "line", hint: "每行一项，最多 20 项。" },
] as const;

type Config = Record<string, unknown>;
type SettingsStatus = 400 | 401 | 409;
class WarpPanelError extends Error {
  constructor(readonly status: SettingsStatus, message: string) { super(message); }
}

function record(value: unknown): Config | undefined {
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return value as Config;
}

function select(settings: Config, keys: readonly string[]) {
  return Object.fromEntries(keys.map(key => [key, settings[key]]));
}

function poolField(key: typeof poolKeys[number]) {
  return `pool${key[0]!.toUpperCase()}${key.slice(1)}`;
}

function fieldsFrom(settings: WarpSettings) {
  const { enabled, multiple, weeklyBonus, automaticPools, reincarnationMinutes, allowance, groups, rates, poolNames } = settings;
  return {
    enabled, multiple, weeklyBonus, automaticPools, reincarnationMinutes, ...allowance, groups, ...rates,
    ...Object.fromEntries(poolKeys.map(key => [poolField(key), poolNames[key] ?? []])),
  };
}

function settingsFrom(values: Config) {
  return {
    ...select(values, ["enabled", "multiple", "weeklyBonus", "automaticPools", "reincarnationMinutes", "groups"]),
    allowance: select(values, allowanceKeys),
    rates: select(values, rateKeys),
    poolNames: Object.fromEntries(poolKeys.flatMap(key => {
      const names = values[poolField(key)];
      return Array.isArray(names) && names.length === 0 ? [] : [[key, names]];
    })),
  };
}

export function panelStarRailWarpSettings(root: URL) {
  const directory = fileURLToPath(new URL("data/starrail/simulation/", root));
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    const verify = async () => {
      if (!active()) throw new WarpPanelError(401, "管理会话已失效。");
    };
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    try {
      await verify();
      const { createWarpSettingsStore, defaultWarpSettings, parseWarpSettings } = await import("../plugins/starrail/simulation/settings.ts");
      const store = createWarpSettingsStore(lockFile, Bun.env.LOTUS_STAR_RAIL_WARP_STATE_DIR?.trim() || directory);
      const snapshot = (settings: WarpSettings) => ({ fields, values: fieldsFrom(settings), defaults: fieldsFrom(defaultWarpSettings()) });
      if (request.method === "GET") {
        const settings = await store.read();
        await verify();
        return Response.json(snapshot(settings));
      }
      let body: Config | undefined;
      try { body = record(await readPanelJson(request, 1_048_576)); }
      catch { throw new WarpPanelError(400, "模拟跃迁设置格式有误。"); }
      const previous = record(body?.previous), values = record(body?.values);
      if (!body || Object.keys(body).length !== 2 || !previous || !values || Object.keys(values).length !== fields.length ||
          !fields.every(({ key }) => Object.hasOwn(values, key))) throw new WarpPanelError(400, "模拟跃迁设置格式有误。");
      let next: WarpSettings;
      try { next = parseWarpSettings(settingsFrom(values)); }
      catch { throw new WarpPanelError(400, "请检查模拟跃迁数值、群号或卡池名单。"); }
      const saved = await store.update(current => {
        if (!isDeepStrictEqual(fieldsFrom(current), previous)) throw new WarpPanelError(409, "模拟跃迁设置已更改。");
        return next;
      }, verify);
      return Response.json(snapshot(saved));
    } catch (error) {
      if (!active()) return new Response(null, { status: 401 });
      if (error instanceof WarpPanelError) return Response.json({ message: error.message }, { status: error.status });
      return new Response(null, { status: 500 });
    }
  };
}
