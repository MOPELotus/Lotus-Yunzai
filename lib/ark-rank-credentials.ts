import type { MessageFallback } from "./commands.ts";
import type { MessageEvent } from "./messages.ts";
import { readPanelJson } from "./panel.ts";
import { postArkQuery, type RankStatsTransport } from "./rank-statistics.ts";

export const arkRankTokenKey = "ark-plugin:customRank:token";
export const arkRankTokenEnvironment = "LOTUS_ARK_CUSTOM_RANK_TOKEN";
export const arkRankCredentialsPath = "/panel/api/settings/native/ark-rank-credentials";

const tokenCommand = /^[#＃井/／]\s*(?:(?:ark配置token|设置排行凭据)([\s\S]*)|排行凭据\s*(状态|清除|用量)?|(排行用量))$/iu;
const tokenInput = /[#＃井/／]\s*(?:ark配置token|设置排行凭据)/iu;
const tokenPattern = /^[\x21-\x7e]{1,2048}$/u;
const environmentHint = `当前由环境变量 ${arkRankTokenEnvironment} 控制，请在部署设置中修改。`;
const storageError = "无法访问排行榜凭据存储，请检查 Valkey 后重试。";
const invalidToken = "请输入有效的 Token，最多 2048 个非空格 ASCII 字符。";
const usageError = "暂时无法查询排行凭据用量，请检查凭据后重试。";

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function quotaNumber(value: unknown, fraction = false) {
  const amount = typeof value === "string" && /^\d{1,16}(?:\.\d{1,8})?$/u.test(value) ? Number(value) : value;
  return typeof amount === "number" && amount >= 0 && amount <= Number.MAX_SAFE_INTEGER &&
    (fraction || Number.isSafeInteger(amount)) ? amount : undefined;
}

function formatUsage(payload: unknown) {
  const result = object(payload);
  const data = object(result?.data);
  if (result?.retcode !== 0 || !data) return usageError;
  const auth = object(data.auth);
  const quota = object(data.quota);
  const rank = object(quota?.rank);
  const custom = object(quota?.custom);
  const remaining = (limit: unknown) => quotaNumber(object(limit)?.remaining) ?? "—";
  const permission = quotaNumber(auth?.permission);
  const multiplier = quotaNumber(auth?.limit_normal, true) ?? 1;
  return [
    `凭据权限：${permission === 1 ? "高级" : "普通"}`,
    `全部请求剩余（分钟／小时／天）：${remaining(rank?.minute)}／${remaining(rank?.hour)}／${remaining(rank?.day)}`,
    `自定义排行普通请求倍率：${multiplier} 倍`,
    `自定义排行普通请求剩余：${remaining(custom?.normal)}`,
    `自定义排行高级请求剩余：${remaining(custom?.advanced)}`,
  ].join("\n");
}

export function isArkRankToken(value: unknown): value is string {
  return typeof value === "string" && tokenPattern.test(value);
}

export function isArkRankTokenCommand(message: string) {
  return tokenCommand.test(message.trim());
}

export function containsArkRankTokenInput(message: MessageEvent["message"]) {
  const text = typeof message === "string" ? message : message.map(part => part.type === "text" ? part.text : "").join("");
  return tokenInput.test(text);
}

interface CredentialStorage {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, token: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

type CredentialSnapshot =
  | { readonly source: "environment" | "stored"; readonly usable: boolean }
  | { readonly source: "none"; readonly usable: false };
type Change = { readonly kind: "set"; readonly token: string } | { readonly kind: "clear" };

class CredentialAuthorityChanged extends Error {}
class CredentialEnvironmentOverride extends Error {}

interface Options {
  readonly signal: AbortSignal;
  readonly storage?: () => CredentialStorage | undefined;
  readonly environment?: () => string | undefined;
  readonly transport?: RankStatsTransport;
}

export function createArkRankCredentialSettings({ signal, storage = () => globalThis.redis,
  environment = () => Bun.env[arkRankTokenEnvironment], transport = fetch }: Options) {
  async function status(): Promise<CredentialSnapshot> {
    const override = environment();
    if (override !== undefined) return { source: "environment", usable: isArkRankToken(override) };
    const store = storage();
    if (!store) throw new Error(storageError);
    const saved = await store.get(arkRankTokenKey);
    return saved != null ? { source: "stored", usable: isArkRankToken(saved) } : { source: "none", usable: false };
  }

  async function modify(change: Change, active: () => boolean): Promise<CredentialSnapshot> {
    if (!active()) throw new CredentialAuthorityChanged();
    if (environment() !== undefined) throw new CredentialEnvironmentOverride();
    const store = storage();
    if (!store) throw new Error(storageError);
    if (change.kind === "set") {
      if (await store.set(arkRankTokenKey, change.token) !== "OK") throw new Error(storageError);
      return { source: "stored", usable: true };
    }
    const deleted = await store.del(arkRankTokenKey);
    if (deleted !== 0 && deleted !== 1) throw new Error(storageError);
    return { source: "none", usable: false };
  }

  const command: MessageFallback = async (message, context) => {
    const match = tokenCommand.exec(message.trim());
    if (!match || signal.aborted) return;
    const usage = match[2] === "用量" || match[3] !== undefined;
    const { privateCredentialSignal: connection, user_id: owner } = context;
    if (context.isDelegated || context.message_type !== "private" || connection?.aborted !== false ||
        owner === undefined || !context.isMaster || !context.isBotMaster(owner) || !context.isFriend) {
      return usage ? "请由当前机器人主人在已绑定的好友私聊查询排行用量。" :
        "请由当前机器人主人在已绑定的好友私聊或管理面板设置排行凭据。";
    }
    const active = () => !signal.aborted && !connection.aborted && context.isBotMaster(owner);
    try {
      const friend = await context.isFriend().catch(() => false);
      if (!active()) return;
      if (!friend) return usage ? "无法确认当前好友私聊，未查询排行用量。" :
        "无法确认当前好友私聊，请通过管理面板设置排行凭据。";
      if (usage) {
        const override = environment();
        const store = override === undefined ? storage() : undefined;
        if (override === undefined && !store) return storageError;
        const token = override ?? await store?.get(arkRankTokenKey);
        if (!active()) return;
        if (token == null) return "尚未设置排行榜 Token。";
        if (!isArkRankToken(token)) return "当前排行榜 Token 格式无效，请检查凭据。";
        const result = await postArkQuery("auth/usage", {}, AbortSignal.any([signal, connection]), transport, { token });
        if (!active()) return;
        return "message" in result ? result.message : formatUsage(result.payload);
      }
      if (match[1] !== undefined) {
        const token = match[1].trim();
        if (!token) return "请在本私聊发送 #设置排行凭据 加空格和 Token，或在管理面板配置。";
        if (!isArkRankToken(token)) return invalidToken;
        await modify({ kind: "set", token }, active);
        return active() ? "排行榜 Token 已保存。" : undefined;
      }
      if (match[2] === "清除") {
        await modify({ kind: "clear" }, active);
        return active() ? "排行榜 Token 已清除。" : undefined;
      }
      const state = await status();
      if (!active()) return;
      if (state.source === "environment") return state.usable ? environmentHint : `${environmentHint} 当前 Token 格式无效。`;
      if (state.source === "stored") return state.usable ? "已保存排行榜 Token。" : "已保存的排行榜 Token 格式无效，请替换或清除。";
      return "尚未设置排行榜 Token。";
    } catch (error) {
      if (!active() || error instanceof CredentialAuthorityChanged) return;
      if (error instanceof CredentialEnvironmentOverride) return environmentHint;
      return storageError;
    }
  };

  async function panel(request: Request, stillAuthorized: () => boolean) {
    const active = () => !signal.aborted && !request.signal.aborted && stillAuthorized();
    const headers = { "Cache-Control": "no-store" };
    const unauthorized = () => new Response(null, { status: 401, headers });
    if (!active()) return unauthorized();
    try {
      let state: CredentialSnapshot;
      switch (request.method) {
        case "GET":
          state = await status();
          break;
        case "PUT": {
          const body = await readPanelJson(request, 16_384).catch(() => undefined);
          if (!active()) return unauthorized();
          if (!body || typeof body !== "object" || Array.isArray(body) ||
              Object.keys(body).length !== 1 || !("token" in body) || !isArkRankToken(body.token)) {
            return Response.json({ message: invalidToken }, { status: 400, headers });
          }
          state = await modify({ kind: "set", token: body.token }, active);
          break;
        }
        case "DELETE":
          state = await modify({ kind: "clear" }, active);
          break;
        default:
          return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, PUT, DELETE" } });
      }
      return active() ? Response.json(state, { headers }) : unauthorized();
    } catch (error) {
      if (!active() || error instanceof CredentialAuthorityChanged) return unauthorized();
      if (error instanceof CredentialEnvironmentOverride) return Response.json({ message: environmentHint }, { status: 409, headers });
      return Response.json({ message: storageError }, { status: 503, headers });
    }
  }

  return { command, panel };
}
