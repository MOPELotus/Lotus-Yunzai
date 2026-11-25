import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { gameCommandProfileId, MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import type { MessageEvent } from "./messages.ts";
import { maxPanelTransferBytes, type createPanelTransferReceiver, type createPanelTransferSource, type PanelTransferOwner } from "./panel-transfer.ts";

export type PanelTransferAccess = {
  readonly source: ReturnType<typeof createPanelTransferSource>;
  readonly receive: ReturnType<typeof createPanelTransferReceiver>;
  readonly exportLevel: 0 | 1 | 2 | 3;
  readonly importLevel: 0 | 1 | 2 | 3;
};

type Game = PanelTransferOwner["game"];
type Parsed = { readonly game: Game; readonly action: "export" | "import"; readonly profileId: number;
  readonly code?: string; readonly uid?: string; readonly invalid?: true };
export type TransferContext = Partial<Pick<MessageEvent, "self_id" | "user_id" | "isDelegated" | "attachmentOnly" |
  "privateCredentialSignal">> & {
  readonly reply?: (message: string, quote?: boolean) => unknown;
  readonly message_type?: string;
  readonly isBotMaster?: (userId: number) => boolean;
  readonly panelTransfer?: PanelTransferAccess;
};

const entry = /^(#原神|#星铁|#|\*)\s*(导出|导入)面板数据([^\r\n]*)$/u;
const format = "LPT1\\.[A-Za-z0-9_-]{1,340}\\.[A-Za-z0-9_-]{24}\\.[A-Za-z0-9_-]{43}";
const capabilityInput = new RegExp(`^${format}$`, "u");
const interceptedCapability = /(?:^|[^A-Za-z0-9_])LPT1\./u;
const profileArgument = /(?:^|\s)档案\s*([1-9]\d{0,2})$/u;
const uidArgument = /^[1-9]\d{8,9}$/u;

export function hasPanelTransferCapability(text: string) {
  return interceptedCapability.test(text);
}

export function matchPanelTransferCommand(message: string): Parsed | undefined {
  const match = entry.exec(message.trim());
  if (!match) return;
  const game = match[1] === "#" || match[1] === "#原神" ? "gs" : "sr";
  const action = match[2] === "导出" ? "export" : "import";
  const input = match[3]!.trim();
  const profile = profileArgument.exec(input);
  const head = profile ? input.slice(0, profile.index).trim() : input;
  const suffix = !profile && /^[1-9]\d{0,2}$/u.test(head) ? Number(head) : undefined;
  const profileId = gameCommandProfileId(game, profile?.[1] ?? suffix);
  const parts = suffix !== undefined || !head ? [] : head.split(/\s+/u);
  const uid = parts.find(part => uidArgument.test(part));
  const code = action === "import" ? parts.find(part => capabilityInput.test(part)) : undefined;
  const invalid = profileId > MAX_PROFILE_ID || parts.length !== Number(Boolean(uid)) + Number(Boolean(code));
  return { game, action, profileId, uid, code, ...(invalid && { invalid: true }) };
}

export type TransferWriteResult =
  { readonly state: "saved" | "unchanged"; readonly added: number } | { readonly state: "invalid" | "discarded" };

export interface TransferArchive {
  readonly uid: string;
  verify(): Promise<void>;
  read(): Promise<Uint8Array | undefined>;
  write(bytes: Uint8Array): Promise<TransferWriteResult>;
}

type BindTransferArchive = (qq: string, profileId: number, signal: AbortSignal) => Promise<TransferArchive>;

export function createPanelTransferCommand(game: Game, signal: AbortSignal, bind: BindTransferArchive) {
  const name = game === "gs" ? $t("lib.panel-transfer-command.text_d1597c51ed") : $t("lib.panel-transfer-command.text_a2927891f0");
  const command = game === "gs" ? "#" : "*";
  return async (parsed: Parsed, context: TransferContext) => {
    if (parsed.game !== game || signal.aborted) return;
    const { message_type: type, self_id: botId, user_id: userId, privateCredentialSignal, panelTransfer } = context;
    if (type !== "private" || context.isDelegated || context.attachmentOnly || !botId || !userId || !privateCredentialSignal) {
      return $t("lib.panel-transfer-command.text_3ecabfec81", { "name": name });
    }
    const level = parsed.action === "export" ? panelTransfer?.exportLevel : panelTransfer?.importLevel;
    if (!panelTransfer || level === undefined || level === 3) return $t("lib.panel-transfer-command.text_5f1ca02ce2", { "name": name, "value2": parsed.action === "export" ? $t("lib.panel-transfer-command.text_76420433f2") : $t("lib.panel-transfer-command.text_576d81bb06") });
    if (level === 2 && !context.isBotMaster?.(userId)) return $t("lib.panel-transfer-command.text_03984b6185");
    if (parsed.invalid) return $t("lib.panel-transfer-command.text_947ba67241", { "command": command, "value2": command });
    if (parsed.action === "import" && !parsed.code) return $t("lib.panel-transfer-command.text_9830be4d67", { "command": command });
    if (parsed.action === "export" && (!panelTransfer.source.enabled || !context.reply)) return $t("lib.panel-transfer-command.text_e8abf3fb15");
    const active = AbortSignal.any([signal, privateCredentialSignal]);
    const qq = String(userId);
    try {
      active.throwIfAborted();
      const archive = await bind(qq, parsed.profileId, active);
      if (parsed.uid && parsed.uid !== archive.uid) return $t("lib.panel-transfer-command.text_61d485c911", { "name": name });
      const owner = { game, qq, uid: archive.uid };
      await archive.verify();
      active.throwIfAborted();
      if (parsed.action === "export") {
        const data = await archive.read();
        if (!data?.byteLength) return $t("lib.panel-transfer-command.text_3f97a9d5c1", { "name": name, "command": command });
        if (data.byteLength > maxPanelTransferBytes) return $t("lib.panel-transfer-command.text_d8e2743aa2");
        await archive.verify();
        active.throwIfAborted();
        const code = panelTransfer.source.offer(owner, data);
        if (!code) return $t("lib.panel-transfer-command.text_22f5f8cd8b");
        let sent = false;
        try {
          sent = await context.reply!($t("lib.panel-transfer-command.text_c0718f677b", { "name": name, "command": command, "code": code }), false) === true;
        } finally {
          if (!sent) panelTransfer.source.withdraw(code, owner);
        }
        return sent ? [] as const : $t("lib.panel-transfer-command.text_cde127ab37");
      }
      const claim = await panelTransfer.receive(parsed.code!, owner, active);
      active.throwIfAborted();
      if (claim.state === "confirmed") return $t("lib.panel-transfer-command.text_63b58c460f");
      if (claim.state === "expired") return $t("lib.panel-transfer-command.text_7bebef59dd");
      if (claim.state === "invalid") return $t("lib.panel-transfer-command.text_a0d0f063f0");
      if (claim.state !== "ready") return $t("lib.panel-transfer-command.text_afe58f4c95");
      await archive.verify();
      active.throwIfAborted();
      const stored = await archive.write(claim.bytes);
      if (stored.state === "invalid") return $t("lib.panel-transfer-command.text_eeac714b3f");
      if (stored.state === "discarded") return $t("lib.panel-transfer-command.text_26517e2d2c");
      const confirmed = await claim.acknowledge(active);
      if (active.aborted) return;
      const result = "added" in stored && stored.added ? $t("lib.panel-transfer-command.text_9bb08f319b", { "added": stored.added, "name": name }) : $t("lib.panel-transfer-command.text_7f01d4d96c");
      return confirmed ? result : $t("lib.panel-transfer-command.text_07bc656d47", { "result": result });
    } catch (error) {
      if (active.aborted) return;
      if (error instanceof ProfileError) {
        if (error.code === "login-required" || error.code === "missing") return $t("lib.panel-transfer-command.text_76720712c8", { "profileId": parsed.profileId });
        if (error.code === "role-missing" || error.code === "invalid") return $t("lib.panel-transfer-command.text_0037be9a0c", { "name": name });
        if (error.code === "changed") return $t("lib.panel-transfer-command.text_494b3a60f0");
      }
      return $t("lib.panel-transfer-command.text_c5c5680591");
    }
  };
}
