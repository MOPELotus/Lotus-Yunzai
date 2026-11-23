import { isDeepStrictEqual } from "node:util";
import { parseWishSettings } from "./genshin-wish-settings-model.ts";
import { GlobalConfigWriteError } from "./lotus-global-config-write.ts";
import { readGenshinWishSettings, updateGenshinWishSettings, wishConfigMaxBytes } from "./genshin-wish-settings.ts";
import { readPanelJson } from "./panel.ts";

const fields = [
  { key: "pink", label: "每日纠缠之缘", type: "number", min: 0, max: 10_000,
    hint: "下一次每日发放时生效。个人票数跨群共用，以当天首次领取会话的设置发放。" },
  { key: "blue", label: "每日相遇之缘", type: "number", min: 0, max: 10_000 },
  { key: "recallSeconds", label: "结果撤回延时（秒）", type: "number", min: 0, max: 120, hint: "填 0 不撤回。" },
  { key: "privateSingleRecallSeconds", label: "私聊单抽撤回延时（秒）", type: "number", min: 0, max: 120,
    hint: "私聊单抽默认不撤回，与十连和群聊分开。" },
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
      const values = await updateGenshinWishSettings(root, current => {
        if (!isDeepStrictEqual(current, previous)) throw new GlobalConfigWriteError("conflict");
        return next;
      }, active, request.signal);
      return Response.json({ fields, values });
    } catch (error) {
      if (!active() || error instanceof GlobalConfigWriteError && error.reason === "permission") return new Response(null, { status: 401 });
      return new Response(null, { status: error instanceof GlobalConfigWriteError && error.reason === "conflict" ? 409 : 500 });
    }
  };
}
