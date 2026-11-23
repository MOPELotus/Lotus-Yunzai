import { MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
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
  const profileId = Number(profile?.[1] ?? suffix ?? 1);
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
  const name = game === "gs" ? "原神" : "星铁";
  const command = game === "gs" ? "#" : "*";
  return async (parsed: Parsed, context: TransferContext) => {
    if (parsed.game !== game || signal.aborted) return;
    const { message_type: type, self_id: botId, user_id: userId, privateCredentialSignal, panelTransfer } = context;
    if (type !== "private" || context.isDelegated || context.attachmentOnly || !botId || !userId || !privateCredentialSignal) {
      return `请在机器人好友私聊中管理本人${name}面板交换。`;
    }
    const level = parsed.action === "export" ? panelTransfer?.exportLevel : panelTransfer?.importLevel;
    if (!panelTransfer || level === undefined || level === 3) return `本机未开启${name}跨机器人面板${parsed.action === "export" ? "导出" : "导入"}。`;
    if (level === 2 && !context.isBotMaster?.(userId)) return "此功能仅供当前机器人主人使用。";
    if (parsed.invalid) return `指令格式不对，请使用 ${command}导出面板数据 档案1 或 ${command}导入面板数据 交接码 档案1。`;
    if (parsed.action === "import" && !parsed.code) return `请先在来源机器人私聊发送 ${command}导出面板数据，再把十分钟交接码发给当前机器人。`;
    if (parsed.action === "export" && (!panelTransfer.source.enabled || !context.reply)) return "来源机器人未配置可供领取的 HTTPS 地址。";
    const active = AbortSignal.any([signal, privateCredentialSignal]);
    const qq = String(userId);
    try {
      active.throwIfAborted();
      const archive = await bind(qq, parsed.profileId, active);
      if (parsed.uid && parsed.uid !== archive.uid) return `指令里的 UID 与所选档案的本人${name}角色不一致。`;
      const owner = { game, qq, uid: archive.uid };
      await archive.verify();
      active.throwIfAborted();
      if (parsed.action === "export") {
        const data = await archive.read();
        if (!data?.byteLength) return `暂无可交换的本人${name}面板，请先 ${command}更新面板。`;
        if (data.byteLength > maxPanelTransferBytes) return "面板数据超过 2 MB，仍可使用本地面板文件导出。";
        await archive.verify();
        active.throwIfAborted();
        const code = panelTransfer.source.offer(owner, data);
        if (!code) return "当前无法创建面板交接，请稍后重试。";
        let sent = false;
        try {
          sent = await context.reply!(`已生成十分钟有效的${name}面板交接码。请在接收机器人好友私聊发送以下整条指令。\n${command}导入面板数据 ${code}`, false) === true;
        } finally {
          if (!sent) panelTransfer.source.withdraw(code, owner);
        }
        return sent ? [] as const : "交接码未能发出，已撤销，请重新导出。";
      }
      const claim = await panelTransfer.receive(parsed.code!, owner, active);
      active.throwIfAborted();
      if (claim.state === "confirmed") return "这份面板交接已完成。";
      if (claim.state === "expired") return "交接已失效或与所选档案身份不符，请核对档案，必要时重新导出。";
      if (claim.state === "invalid") return "交接码、来源或面板版本不受支持。";
      if (claim.state !== "ready") return "暂时无法连接来源机器人，可以用同一交接码重试。";
      await archive.verify();
      active.throwIfAborted();
      const stored = await archive.write(claim.bytes);
      if (stored.state === "invalid") return "来源面板的 UID 或格式与所选档案不符。";
      if (stored.state === "discarded") return "这份面板早于本档案的删除记录，未恢复旧数据。请先在来源机器人更新面板再导出。";
      const confirmed = await claim.acknowledge(active);
      if (active.aborted) return;
      const result = "added" in stored && stored.added ? `已导入 ${stored.added} 名${name}角色面板，已有角色记录保留。` : "本档案已包含这份面板的角色，现有记录已保留。";
      return confirmed ? result : `${result}来源端尚未确认，可用同一交接码重试确认。`;
    } catch (error) {
      if (active.aborted) return;
      if (error instanceof ProfileError) {
        if (error.code === "login-required" || error.code === "missing") return `请先登录档案 ${parsed.profileId}。`;
        if (error.code === "role-missing" || error.code === "invalid") return `请在所选档案同步本人${name}角色。`;
        if (error.code === "changed") return "档案或本地面板已变更，请重新操作。";
      }
      return "暂时无法交换面板，请稍后重试。";
    }
  };
}
