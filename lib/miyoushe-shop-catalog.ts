import { createProfileStore, type ProfileAccountContext } from "@lotus-yunzai/account";
import { createProfileHoyoClient, HoyoRequestError, isCookieExpired } from "@lotus-yunzai/hoyo-client";
import { MiyousheShopError, readMiyousheShop } from "@lotus-yunzai/hoyo-client/miyoushe-shop";
import type { MiyousheOverviewTarget } from "./miyoushe-overview.ts";

const publicAssetHost = "bbs-static.miyoushe.com";
const pageSize = 20;
const pageLimit = 100;
const codePattern = /^[a-zA-Z0-9_]{1,32}$/u;
const goodsIdPattern = /^[1-9]\d{0,19}$/u;
const gameKeys: ReadonlyMap<string, "gs" | "sr" | "zzz" | "bh3" | "bh2" | "nxx"> = new Map([["hk4e_cn", "gs"], ["hkrpg_cn", "sr"], ["nap_cn", "zzz"],
  ["bh3_cn", "bh3"], ["bh2_cn", "bh2"], ["nxx_cn", "nxx"]] as const);
type Json = Record<string, unknown>;
type ProductStatus = "available" | "scheduled" | "sold_out" | "ended" | "unknown";

export { MiyousheShopError };

function invalidResponse(): never {
  throw new MiyousheShopError(502, "商城返回的数据格式有误。");
}

function object(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function count(value: unknown) {
  const number = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function milliseconds(value: unknown) {
  const seconds = count(value);
  return seconds && seconds <= 253_402_300_799 ? seconds * 1000 : null;
}

function text(value: unknown, limit = 240) {
  return typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, limit) : "";
}

function requirements(value: unknown) {
  if (typeof value !== "string") return "";
  return value.slice(0, 20_000)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "")
    .replace(/<\/?(?:p|div|li|br)\b[^>]*>/giu, "\n")
    .replace(/<[^>]*>/gu, "")
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-f]{1,6});/giu, match => {
      const entity = match.slice(1, -1).toLowerCase();
      if (entity.startsWith("#")) {
        const value = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
      }
      return ({ nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity] ?? "";
    })
    .replace(/\r\n?/gu, "\n")
    .replace(/[^\S\n]+/gu, " ")
    .replace(/\n(?:\s*\n)+/gu, "\n\n").trim().slice(0, 6_000);
}

function icon(value: unknown) {
  const url = typeof value === "string" && value.length <= 500 ? URL.parse(value) : null;
  if (!url || url.protocol !== "https:" || url.hostname !== publicAssetHost || url.username || url.password ||
      url.port || url.search || url.hash || !/^\/static\/[\w/-]+\.(?:png|jpe?g|webp)$/iu.test(url.pathname)) return "";
  return url.href;
}

function product(value: unknown, now: number) {
  const raw = object(value);
  if (!raw) invalidResponse();
  const id = typeof raw.goods_id === "string" ? raw.goods_id : String(count(raw.goods_id) ?? "");
  const name = text(raw.goods_name);
  const price = count(raw.price);
  if (!goodsIdPattern.test(id) || !name || price === null) invalidResponse();
  const stock = count(raw.total);
  const unlimited = raw.unlimit === true;
  const serverNow = milliseconds(raw.now_time) ?? now;
  const endsAt = milliseconds(raw.end);
  const candidates = [milliseconds(raw.sale_start_time), milliseconds(raw.next_time)]
    .filter((time): time is number => time !== null && time > serverNow && (endsAt === null || time < endsAt));
  const opensAt = candidates.length ? Math.min(...candidates) : null;
  const missingStart = raw.status === "not_in_sell" && opensAt === null;
  let status: ProductStatus = "unknown";
  if (endsAt !== null && endsAt <= serverNow) status = "ended";
  else if (raw.status === "online" && (unlimited || (stock !== null && stock > 0))) status = "available";
  else if (opensAt !== null) status = "scheduled";
  else if (stock === 0 && !missingStart) status = "sold_out";
  return {
    id, name, price, icon: icon(raw.icon), type: count(raw.type), gameBiz: text(raw.game_biz, 32), game: text(raw.game, 32),
    limitCycle: text(raw.account_cycle_type, 32), roleCycle: text(raw.role_cycle_type, 32),
    saleStartsAt: milliseconds(raw.sale_start_time), startsAt: milliseconds(raw.start),
    stock, unlimited, nextStock: count(raw.next_num), opensAt: status === "scheduled" ? opensAt : null, endsAt, status,
    serverNow, missingStart,
    accountLimit: raw.account_cycle_type === "not_limit" ? null : count(raw.account_cycle_limit),
    roleLimit: raw.role_cycle_type === "not_limit" ? null : count(raw.role_cycle_limit),
    requirements: requirements(raw.goods_detail),
  };
}

function filters(query: URLSearchParams) {
  const page = query.get("page") ?? "1";
  const game = query.get("game") ?? "";
  if ([...query.keys()].some(key => key !== "page" && key !== "game") ||
    query.getAll("page").length > 1 || query.getAll("game").length > 1 ||
    !/^[1-9]\d{0,2}$/u.test(page) || Number(page) > pageLimit || (game && !codePattern.test(game))) {
    throw new MiyousheShopError(400, "商城分区或页码格式错误。");
  }
  return { page: Number(page), game: game === "all" ? "" : game };
}

function redacted(value: string, account: ProfileAccountContext) {
  const { cookie, stoken, stokenCookie, ltoken, mid } = account.account;
  if ([cookie, stoken, stokenCookie, ltoken, mid, account.device.id, account.device.fp]
    .some(secret => secret && value.includes(secret))) return "";
  return text(value, 80);
}

interface ShopOptions {
  readonly profileDirectory?: string | URL;
  readonly transport?: Parameters<typeof createProfileHoyoClient>[1];
  readonly now?: () => number;
}

export function createMiyousheShopCatalog({ profileDirectory, transport = fetch, now = Date.now }: ShopOptions = {}) {
  const profiles = createProfileStore(profileDirectory);
  const roleClient = createProfileHoyoClient(profiles, transport);
  async function getProduct(id: string, signal?: AbortSignal) {
    if (!goodsIdPattern.test(id)) throw new MiyousheShopError(400, "商品编号无效。");
    const value = product(await readMiyousheShop(transport, "detail", { goods_id: id }, signal), now());
    if (value.id !== id) invalidResponse();
    return value;
  }

  async function readBoundRoles(account: ProfileAccountContext, signal?: AbortSignal, verifyLogin?: () => Promise<void>) {
    async function verify() {
      signal?.throwIfAborted();
      await verifyLogin?.();
      const current = await profiles.accountContext(account.qq, account.profileId);
      signal?.throwIfAborted();
      if (current.revision !== account.revision) {
        throw new HoyoRequestError("profile-changed", "档案已变更，请刷新后重试。");
      }
    }
    await verify();
    let catalog;
    try {
      catalog = await roleClient.fetchRoleCatalog(account, signal);
    } catch (error) {
      if (!isCookieExpired(error)) throw error;
      await verify();
      account = await roleClient.refreshCredentials(account);
      await verify();
      catalog = await roleClient.fetchRoleCatalog(account, signal);
    }
    await verify();
    return { account, catalog };
  }

  return {
    async trackingRoles(target: MiyousheOverviewTarget, gameBiz: string, signal?: AbortSignal, verifyLogin?: () => Promise<void>) {
      const game = gameKeys.get(gameBiz);
      if (!game) return [];
      await verifyLogin?.();
      const { account, catalog } = await readBoundRoles(await profiles.accountContext(target.qq, target.profileId), signal, verifyLogin);
      return catalog[game].filter(role => role.gameBiz === gameBiz && /^[a-z0-9_]{1,32}$/iu.test(role.region))
        .map(role => ({ uid: role.uid, region: role.region, gameBiz, nickname: redacted(role.nickname, account) }));
    },
    async list(_target: MiyousheOverviewTarget, query: URLSearchParams, signal?: AbortSignal,
      verifyLogin?: () => Promise<void>) {
      const { page, game } = filters(query);
      await verifyLogin?.();
      const data = await readMiyousheShop(transport, "list", { page: String(page), page_size: String(pageSize), game }, signal);
      const total = count(data.total);
      if (!Array.isArray(data.list) || data.list.length > pageSize || total === null) invalidResponse();
      const goods = data.list.map(item => product(item, now()));
      // Old listing looks up omitted sale times in product detail.
      const incomplete = goods.filter(item => item.missingStart);
      const optionalTimeout = AbortSignal.timeout(3_500);
      const optional = signal ? AbortSignal.any([signal, optionalTimeout]) : optionalTimeout;
      for (let offset = 0; offset < incomplete.length && !optional.aborted; offset += 4) {
        await Promise.all(incomplete.slice(offset, offset + 4).map(async item => {
          try { Object.assign(item, await getProduct(item.id, optional)); }
          catch (error) { if (error instanceof MiyousheShopError && error.status === 429) throw error; }
        }));
      }
      const games = new Map<string, string>();
      if (Array.isArray(data.games)) for (const entry of data.games.slice(0, 32)) {
        const game = object(entry);
        const key = text(game?.key, 32), name = text(game?.name, 40);
        if (codePattern.test(key) && key !== "all" && name) games.set(key, name);
      }
      signal?.throwIfAborted();
      await verifyLogin?.();
      return {
        page, pageSize, total, totalPages: Math.max(1, Math.min(pageLimit, Math.ceil(total / pageSize))),
        now: goods[0]?.serverNow ?? now(),
        games: Array.from(games, ([key, name]) => ({ key, name })),
        goods: goods.map(({ missingStart: _missingStart, requirements: _requirements, ...item }) => item),
      };
    },

    async detail(target: MiyousheOverviewTarget, id: string, signal?: AbortSignal, verifyLogin?: () => Promise<void>) {
      await verifyLogin?.();
      const { missingStart: _missingStart, ...good } = await getProduct(id, signal);
      const game = gameKeys.get(good.gameBiz);
      if (good.type !== 2 || !game) return { good, roles: [], roleError: undefined };
      const profile = await profiles.accountContext(target.qq, target.profileId);
      try {
        const { account, catalog } = await readBoundRoles(profile, signal, verifyLogin);
        const roles = catalog[game]
          .filter(role => role.gameBiz === good.gameBiz && /^[a-z0-9_]{1,32}$/iu.test(role.region))
          .map(role => ({ uid: role.uid, nickname: redacted(role.nickname, account), region: role.region,
            regionName: redacted(role.regionName ?? "", account), level: count(role.level) }));
        return { good, roles, roleError: undefined };
      } catch (error) {
        signal?.throwIfAborted();
        await verifyLogin?.();
        if (error instanceof HoyoRequestError && error.code === "profile-changed") throw error;
        return { good, roles: [], roleError: "暂时无法读取当前档案的角色。请在米游社确认绑定状态后重试。" };
      }
    },
  };
}
