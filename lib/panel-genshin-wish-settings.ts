import { isDeepStrictEqual } from "node:util";
import { parseWishSettings } from "./genshin-wish-settings-model.ts";
import { GlobalConfigWriteError } from "./lotus-global-config-write.ts";
import { readGenshinWishSettings, updateGenshinWishSettings, wishConfigMaxBytes } from "./genshin-wish-settings.ts";
import { readPanelJson } from "./panel.ts";

const fields = [
  { key: "enabled", label: "启用原神模拟祈愿", type: "boolean" },
  { key: "multiple", label: "允许单次超过十连", type: "boolean" },
  { key: "characterFive", label: "角色池五星基础概率（万分比）", type: "number", min: 0, max: 10_000 },
  { key: "characterFour", label: "角色池四星基础概率（万分比）", type: "number", min: 0, max: 10_000 },
  { key: "weaponFive", label: "武器池五星基础概率（万分比）", type: "number", min: 0, max: 10_000 },
  { key: "weaponFour", label: "武器池四星基础概率（万分比）", type: "number", min: 0, max: 10_000 },
  { key: "featuredFive", label: "五星小保底命中率（百分比）", type: "number", min: 0, max: 100, nullable: true,
    hint: "留空使用角色 50%、武器 75%。保底和定轨仍然生效。" },
  { key: "automaticPools", label: "使用自动轮换卡池", type: "boolean",
    hint: "手工名单会保留，关闭自动轮换后用于公共模拟祈愿。" },
  { key: "poolCharacterFive", label: "手工五星角色名单", type: "list", separator: "line",
    hint: "每行一名。填一名时两个角色池共用，填两名时按顺序使用。" },
  { key: "poolCharacterFour", label: "手工四星角色名单", type: "list", separator: "line",
    hint: "每行一名，留空沿用默认名单。" },
  { key: "poolWeaponFive", label: "手工五星武器名单", type: "list", separator: "line",
    hint: "每行一件，填写两件或留空沿用默认名单。" },
  { key: "poolWeaponFour", label: "手工四星武器名单", type: "list", separator: "line",
    hint: "每行一件，留空沿用默认名单。" },
  { key: "pink", label: "每日纠缠之缘", type: "number", min: 0, max: 10_000,
    hint: "下一次每日发放时生效。个人票数跨群共用，以当天首次领取会话的设置发放。" },
  { key: "blue", label: "每日相遇之缘", type: "number", min: 0, max: 10_000 },
  { key: "recallSeconds", label: "结果撤回延时（秒）", type: "number", min: 0, max: 120, hint: "填 0 不撤回。" },
  { key: "privateSingleRecallSeconds", label: "私聊单抽撤回延时（秒）", type: "number", min: 0, max: 120,
    hint: "私聊单抽默认不撤回，与十连和群聊分开。" },
  { key: "reincarnationMinutes", label: "转生冷却（分钟）", type: "number", min: 1, max: 1440,
    hint: "下一次转生起生效。同一个 QQ 的群聊与私聊共用冷却，机器人主人不受限制。" },
  { key: "dailyDrawLimits", label: "按会话的每日抽数限制", type: "json", rows: 8,
    hint: '钱包仍先检查。default 为默认，private 为私聊，也可填群号。count 每单位 10 抽，separate 为 true 时武器单独计数。null 表示该会话取消继承，例如 {"default":{"count":1,"separate":false},"123456789":null}。' },
  { key: "groups", label: "按群覆盖", type: "json",
    hint: '用群号作为键，只填写要覆盖的字段 pink、blue、recallSeconds，例如 {"123456789":{"pink":25,"recallSeconds":0}}。' },
] as const;

function input(value: unknown) {
  if (!value || typeof value !== "object" || Object.keys(value).length !== fields.length ||
      !fields.every(({ key }) => Object.hasOwn(value, key))) return;
  return parseWishSettings(value);
}

export function panelGenshinWishSettings(root: URL) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    try {
      if (request.method === "GET") {
        const values = await readGenshinWishSettings(root);
        return active() ? Response.json({ fields, values }) : new Response(null, { status: 401 });
      }
      const body = await readPanelJson(request, wishConfigMaxBytes).catch(() => undefined);
      if (!body || typeof body !== "object" || !("previous" in body) || !("values" in body)) {
        return new Response(null, { status: 400 });
      }
      let previous: ReturnType<typeof input>, next: ReturnType<typeof input>;
      try {
        previous = input(body.previous);
        next = input(body.values);
      } catch (error) {
        return Response.json({ message: (error as Error).message }, { status: 400 });
      }
      if (!previous || !next) return new Response(null, { status: 400 });
      let normalized;
      try {
        const { normalizeWishManualPoolChanges } = await import("../plugins/genshin/wish-sim/admin-pools.ts");
        normalized = await normalizeWishManualPoolChanges(previous, next);
      } catch (error) {
        if (error instanceof TypeError) return Response.json({ message: error.message }, { status: 400 });
        throw error;
      }
      const values = await updateGenshinWishSettings(root, current => {
        if (!isDeepStrictEqual(current, previous)) throw new GlobalConfigWriteError("conflict");
        return normalized;
      }, active, request.signal);
      return Response.json({ fields, values });
    } catch (error) {
      if (!active() || error instanceof GlobalConfigWriteError && error.reason === "permission") return new Response(null, { status: 401 });
      return new Response(null, { status: error instanceof GlobalConfigWriteError && error.reason === "conflict" ? 409 : 500 });
    }
  };
}
