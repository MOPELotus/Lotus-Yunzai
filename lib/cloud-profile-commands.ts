import { MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import { CloudGenshinWalletError, HoyoRequestError, normalizeCloudGenshinComboToken, readCloudGenshinWallet } from "@lotus-yunzai/hoyo-client";
import type { CommandContext, CommandModule, CommandReply, MessageFallbackContext } from "./commands.ts";

const secretPrefix = /^\s*[#＃井/]\s*绑定\s*云\s*(?:原神|绝区零)\s*token/iu;
const binding = /^\s*[#＃井/]\s*绑定\s*云\s*(原神|绝区零)\s*token([0-9]*)[ \t]+([^\r\n]+)$/iu;
const toggle = /^#(启用|开启|关闭|禁用)云(原神|绝区零)(?:签到)?([0-9]*)$/u;

type CloudGame = "genshin" | "zzz";
interface CloudProfileCommandsOptions {
  readonly signal: AbortSignal;
  readonly readProfile: (qq: string, profileId: number) => Promise<{ readonly loggedIn: boolean; readonly revision: string }>;
  readonly saveToken: (qq: string, profileId: number, revision: string, game: "genshin", token: string, signal: AbortSignal) => Promise<unknown>;
  readonly setEnabled: (qq: string, profileId: number, revision: string, game: CloudGame, enabled: boolean) => Promise<unknown>;
  readonly viewProfile: (profileId: number, context: CommandContext) => CommandReply | Promise<CommandReply>;
  readonly readWallet?: typeof readCloudGenshinWallet;
}

export function isCloudTokenInput(raw: string): boolean {
  return secretPrefix.test(raw);
}

function profileId(suffix: string) {
  const id = Number(suffix || 1);
  if ((!suffix || /^[1-9]\d{0,2}$/u.test(suffix)) && id <= MAX_PROFILE_ID) return id;
}

function userId(context: CommandContext) {
  const id = context.user_id;
  if (id !== undefined && Number.isSafeInteger(id) && id > 0) return String(id);
}

function missing(error: unknown): boolean {
  return error instanceof ProfileError && (error.code === "missing" || error.code === "login-required");
}

export function cloudProfileCommands({
  signal, readProfile, saveToken, setEnabled, viewProfile, readWallet = readCloudGenshinWallet,
}: CloudProfileCommandsOptions): CommandModule {
  async function bindToken(message: string, context: MessageFallbackContext) {
    if (context.message_type !== "private") return "请勿在群聊或终端发送云游戏凭据。";
    const match = binding.exec(message);
    if (!match) return "请发送 #绑定云原神token 加空格和凭据，可在指令后加档案编号。";
    const [, game, suffix, input] = match;
    if (game === "绝区零") return "云绝区零暂不接收新凭据，请勿再发送 token。";
    const id = profileId(suffix!);
    if (id === undefined) return "档案编号须在 1 到 255 之间。";
    const session = context.privateCredentialSignal;
    const qq = userId(context);
    if (!session || session.aborted || !qq) return "请从当前连接的机器人好友私聊绑定云原神凭据。";

    const scoped = AbortSignal.any([signal, session]);
    let saved = false;
    try {
      const token = normalizeCloudGenshinComboToken(input!);
      const current = await readProfile(qq, id);
      if (!current.loggedIn) return `请先登录 profile ${id}。`;
      const verifyProfile = async () => {
        scoped.throwIfAborted();
        const next = await readProfile(qq, id).catch(() => undefined);
        if (!next?.loggedIn || next.revision !== current.revision) throw new ProfileError("changed", "档案已变更。");
        scoped.throwIfAborted();
      };

      await verifyProfile();
      await readWallet(token, fetch, { signal: scoped, verifyProfile });
      await verifyProfile();
      await saveToken(qq, id, current.revision, "genshin", token, scoped);
      saved = true;
      if (!scoped.aborted) {
        const { message: _message, raw_message: _raw, normalizedMessage: _normalized, ...profileContext } = context;
        return await viewProfile(id, profileContext);
      }
    } catch (error) {
      if (scoped.aborted) return;
      if (saved) return `档案 ${id} 的云原神凭据已保存，暂时无法显示资料卡。`;
      if (missing(error)) return `请先登录 profile ${id}。`;
      if (error instanceof ProfileError && error.code === "changed") return "档案已变更，请重新绑定云原神凭据。";
      if (error instanceof CloudGenshinWalletError && error.reason === "expired") return "云原神凭据已失效，请在官方客户端重新登录后绑定。";
      if (error instanceof HoyoRequestError && error.code === "invalid-input") return "请输入有效的云原神凭据。";
      return "暂时无法读取云原神钱包，档案未更新。";
    }
  }

  return {
    name: "@lotus-yunzai/cloud-profile", commands: {},
    async fallback(_message, context) {
      if (signal.aborted) return;
      const message = context.normalizedMessage;
      if (isCloudTokenInput(message) || isCloudTokenInput(context.raw_message ?? "")) return bindToken(message, context);
      const match = toggle.exec(message);
      if (!match) return;
      const [, action, label, suffix] = match;
      const id = profileId(suffix!);
      if (id === undefined) return "档案编号须在 1 到 255 之间。";
      const qq = userId(context);
      if (!qq || context.message_type === "terminal") return "请从对应的 QQ 会话设置云游戏。";
      let saved = false;
      try {
        const current = await readProfile(qq, id);
        if (signal.aborted) return;
        if (!current.loggedIn) return `请先登录 profile ${id}。`;
        await setEnabled(qq, id, current.revision, label === "原神" ? "genshin" : "zzz", action === "启用" || action === "开启");
        saved = true;
        if (!signal.aborted) return await viewProfile(id, context);
      } catch (error) {
        if (signal.aborted) return;
        if (saved) return `档案 ${id} 的云游戏设置已保存，暂时无法显示资料卡。`;
        if (missing(error)) return `请先登录 profile ${id}。`;
        if (error instanceof ProfileError && error.code === "changed") return "档案设置已变化，请重试。";
        return "暂时无法保存云游戏设置。";
      }
    },
  };
}
