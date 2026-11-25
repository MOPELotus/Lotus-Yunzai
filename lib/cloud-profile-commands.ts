import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import { CloudGenshinWalletError, CloudZzzWalletError, HoyoRequestError, normalizeCloudGenshinComboToken,
  normalizeCloudZzzComboToken, readCloudGenshinWallet, readCloudZzzWallet } from "@lotus-yunzai/hoyo-client";
import type { CommandContext, CommandModule, CommandReply, MessageFallbackContext } from "./commands.ts";

const secretPrefix = /^\s*[#＃井/]\s*绑定\s*云\s*(?:原神|绝区零)\s*token/iu;
const binding = /^\s*[#＃井/]\s*绑定\s*云\s*(原神|绝区零)\s*token([0-9]*)[ \t]+([^\r\n]+)$/iu;
const walletQuery = /^#*云原神查询([0-9]*)$/u;
const toggle = /^#(启用|开启|关闭|禁用)云(原神|绝区零)(?:签到)?([0-9]*)$/u;

type CloudGame = "genshin" | "zzz";
interface CloudProfileCommandsOptions {
  readonly signal: AbortSignal;
  readonly readProfile: (qq: string, profileId: number) => Promise<{ readonly loggedIn: boolean; readonly revision: string }>;
  readonly saveToken: (qq: string, profileId: number, revision: string, game: CloudGame, token: string, signal: AbortSignal) => Promise<unknown>;
  readonly setEnabled: (qq: string, profileId: number, revision: string, game: CloudGame, enabled: boolean) => Promise<unknown>;
  readonly viewProfile: (profileId: number, context: CommandContext) => CommandReply | Promise<CommandReply>;
  readonly readWallet?: typeof readCloudGenshinWallet;
  readonly readZzzWallet?: typeof readCloudZzzWallet;
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

export function cloudWalletProfile(message: string) {
  const match = walletQuery.exec(message);
  if (match) return profileId(match[1]!) ?? null;
}

interface CloudWalletQueryOptions {
  readonly readDomesticCloud: (qq: string, profileId: number) => Promise<{
    readonly loggedIn: boolean; readonly revision: string; readonly token: string;
  }>;
  readonly readProfile: CloudProfileCommandsOptions["readProfile"];
  readonly transport?: Parameters<typeof readCloudGenshinWallet>[1];
  readonly readWallet?: typeof readCloudGenshinWallet;
}

export function createCloudGenshinWalletQuery({
  readDomesticCloud, readProfile, transport = fetch, readWallet = readCloudGenshinWallet,
}: CloudWalletQueryOptions) {
  return async (user: number, id: number, signal: AbortSignal) => {
    const qq = String(user);
    if (signal.aborted) return;
    try {
      const current = await readDomesticCloud(qq, id);
      signal.throwIfAborted();
      if (!current.loggedIn) return $t("lib.cloud-profile-commands.text_62b08191fe", { "id": id });
      if (!current.token) return $t("lib.cloud-profile-commands.text_5073be696b", { "id": id });
      const verifyProfile = async () => {
        signal.throwIfAborted();
        const latest = await readProfile(qq, id).catch(() => undefined);
        if (!latest?.loggedIn || latest.revision !== current.revision) throw new ProfileError("changed", $t("lib.cloud-profile-commands.text_8a1edc5158"));
        signal.throwIfAborted();
      };
      await verifyProfile();
      const wallet = await readWallet(current.token, transport, { signal: signal, verifyProfile });
      await verifyProfile();
      return [
        $t("lib.cloud-profile-commands.text_4f62054abe", { "id": id }),
        ...(wallet.cloudCoins !== undefined ? [$t("lib.cloud-profile-commands.text_8be4d0e378", { "cloudCoins": wallet.cloudCoins })] : []),
        $t("lib.cloud-profile-commands.text_7c33007d93", { "freeTimeMinutes": wallet.freeTimeMinutes }),
        ...(wallet.totalTimeMinutes !== undefined ? [$t("lib.cloud-profile-commands.text_0ad0336aef", { "totalTimeMinutes": wallet.totalTimeMinutes })] : []),
      ].join("\n");
    } catch (error) {
      if (signal.aborted) return;
      if (missing(error)) return $t("lib.cloud-profile-commands.text_62b08191fe", { "id": id });
      if (error instanceof ProfileError && error.code === "changed") return $t("lib.cloud-profile-commands.text_8651fb2117");
      if (error instanceof CloudGenshinWalletError) return error.message;
      if (error instanceof HoyoRequestError && error.code === "invalid-input") return $t("lib.cloud-profile-commands.text_1df5509062", { "id": id });
      return $t("lib.cloud-profile-commands.text_a23b62d4a1");
    }
  };
}

export function cloudProfileCommands({
  signal, readProfile, saveToken, setEnabled, viewProfile, readWallet = readCloudGenshinWallet, readZzzWallet = readCloudZzzWallet,
}: CloudProfileCommandsOptions): CommandModule {
  async function bindToken(message: string, context: MessageFallbackContext) {
    if (context.message_type !== "private") return $t("lib.cloud-profile-commands.text_b8b7673a92");
    const match = binding.exec(message);
    if (!match) return $t("lib.cloud-profile-commands.text_07b095a113");
    const [, label, suffix, input] = match;
    const game = label === "原神" ? "genshin" : "zzz";
    const name = $t("lib.cloud-profile-commands.text_d020f268cb", { "label": label });
    const id = profileId(suffix!);
    if (id === undefined) return $t("lib.cloud-profile-commands.text_3dd62228d2");
    const session = context.privateCredentialSignal;
    const qq = userId(context);
    if (!session || session.aborted || !qq) return $t("lib.cloud-profile-commands.text_b4fd89d4a0", { "name": name });

    const scoped = AbortSignal.any([signal, session]);
    let saved = false;
    try {
      const token = (game === "genshin" ? normalizeCloudGenshinComboToken : normalizeCloudZzzComboToken)(input!);
      const current = await readProfile(qq, id);
      if (!current.loggedIn) return $t("lib.cloud-profile-commands.text_62b08191fe", { "id": id });
      const verifyProfile = async () => {
        scoped.throwIfAborted();
        const next = await readProfile(qq, id).catch(() => undefined);
        if (!next?.loggedIn || next.revision !== current.revision) throw new ProfileError("changed", $t("lib.cloud-profile-commands.text_8a1edc5158"));
        scoped.throwIfAborted();
      };

      await verifyProfile();
      const read = game === "genshin" ? readWallet : readZzzWallet;
      await read(token, fetch, { signal: scoped, verifyProfile });
      await verifyProfile();
      await saveToken(qq, id, current.revision, game, token, scoped);
      saved = true;
      if (!scoped.aborted) {
        const { message: _message, raw_message: _raw, normalizedMessage: _normalized, ...profileContext } = context;
        return await viewProfile(id, profileContext);
      }
    } catch (error) {
      if (scoped.aborted) return;
      if (saved) return $t("lib.cloud-profile-commands.text_c8a7010d74", { "id": id, "name": name });
      if (missing(error)) return $t("lib.cloud-profile-commands.text_62b08191fe", { "id": id });
      if (error instanceof ProfileError && error.code === "changed") return $t("lib.cloud-profile-commands.text_e479d0ec59", { "name": name });
      if ((error instanceof CloudGenshinWalletError || error instanceof CloudZzzWalletError) && error.reason === "expired") return error.message;
      if (error instanceof HoyoRequestError && error.code === "invalid-input") return $t("lib.cloud-profile-commands.text_1819e082d3", { "name": name });
      return $t("lib.cloud-profile-commands.text_714c85fc19", { "name": name });
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
      if (id === undefined) return $t("lib.cloud-profile-commands.text_3dd62228d2");
      const qq = userId(context);
      if (!qq || context.message_type === "terminal") return $t("lib.cloud-profile-commands.text_0bde32a470");
      let saved = false;
      try {
        const current = await readProfile(qq, id);
        if (signal.aborted) return;
        if (!current.loggedIn) return $t("lib.cloud-profile-commands.text_62b08191fe", { "id": id });
        await setEnabled(qq, id, current.revision, label === "原神" ? "genshin" : "zzz", action === "启用" || action === "开启");
        saved = true;
        if (!signal.aborted) return await viewProfile(id, context);
      } catch (error) {
        if (signal.aborted) return;
        if (saved) return $t("lib.cloud-profile-commands.text_998c47c16c", { "id": id });
        if (missing(error)) return $t("lib.cloud-profile-commands.text_62b08191fe", { "id": id });
        if (error instanceof ProfileError && error.code === "changed") return $t("lib.cloud-profile-commands.text_3ddebc59b1");
        return $t("lib.cloud-profile-commands.text_1bb7e909b2");
      }
    },
  };
}
