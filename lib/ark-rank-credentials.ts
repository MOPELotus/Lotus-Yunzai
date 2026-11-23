import type { MessageFallback } from "./commands.ts";
import type { MessageEvent } from "./messages.ts";
import { readPanelJson } from "./panel.ts";

export const arkRankTokenKey = "ark-plugin:customRank:token";
export const arkRankTokenEnvironment = "LOTUS_ARK_CUSTOM_RANK_TOKEN";
export const arkRankCredentialsPath = "/panel/api/settings/native/ark-rank-credentials";

const tokenCommand = /^[#＃井/／]\s*(?:(?:ark配置token|设置排行凭据)([\s\S]*)|排行凭据\s*(状态|清除)?)$/iu;
const tokenInput = /[#＃井/／]\s*(?:ark配置token|设置排行凭据)/iu;
const tokenPattern = /^[\x21-\x7e]{1,2048}$/u;
const environmentHint = `当前由环境变量 ${arkRankTokenEnvironment} 控制，请在部署设置中修改。`;
const storageError = "无法访问排行榜凭据存储，请检查 Valkey 后重试。";
const invalidToken = "请输入有效的 Token，最多 2048 个非空格 ASCII 字符。";

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
}

export function createArkRankCredentialSettings({ signal, storage = () => globalThis.redis,
  environment = () => Bun.env[arkRankTokenEnvironment] }: Options) {
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
    const { privateCredentialSignal: connection, user_id: owner } = context;
    if (context.isDelegated || context.message_type !== "private" || connection?.aborted !== false ||
        owner === undefined || !context.isMaster || !context.isBotMaster(owner) || !context.isFriend) {
      return "请由当前机器人主人在已绑定的好友私聊或管理面板设置排行凭据。";
    }
    const active = () => !signal.aborted && !connection.aborted && context.isBotMaster(owner);
    try {
      const friend = await context.isFriend().catch(() => false);
      if (!active()) return;
      if (!friend) return "无法确认当前好友私聊，请通过管理面板设置排行凭据。";
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
