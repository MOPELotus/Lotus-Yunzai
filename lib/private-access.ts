import { readLocalConfig } from "./config.ts";
import { isMilkyOwnerSession } from "./command-permissions.ts";
import type { MessageEvent } from "./messages.ts";

const legacyEntry = /ltoken|_MHYUUID|authkey=|导出记录|(?:记录|安卓|苹果|ck|cookie|体力)帮助|^#?帮助$|^#*(?:删除|我的)ck$|^#(?:我的)?(?:uid|UID)[0-9]{0,2}$/u;
const accountEntry = /^#(?:登录列表|账号列表|(?:清除|删除)(?:登录|扫码登录|[cC]ookie)[0-9]{0,2})$/u;
const gachaImportEntry = /^#?(?:原神)?(?:强制)?导入记录(?:json)?(?:[1-9]\d{0,2})?$/u;
const groupReviewEntry = /^#(?:入群申请|同意入群|拒绝入群)(?:\s|$)/u;
const allowedFile = /\.(?:txt|xlsx|json)$/iu;
const defaultMessage = "私聊功能已禁用，仅支持发送cookie，抽卡记录链接，记录日志文件";
const cooldownMs = 10_000;
const maxCooldownEntries = 10_000;

type ClaimTip = (userId: number) => Promise<boolean>;

export async function readPrivateAccess(root: URL, claimTip?: ClaimTip) {
  const config = await readLocalConfig(root, "other");
  const enabled = Boolean(config.disablePrivate);
  const tip = typeof config.disableMsg === "string" ? config.disableMsg : defaultMessage;
  const configured = Object.hasOwn(config, "disableAdopt") ? config.disableAdopt : ["stoken"];
  const patterns = Array.isArray(configured)
    ? configured.filter((entry): entry is string => typeof entry === "string" && entry !== "") : [];
  let custom: RegExp | undefined;
  if (enabled && patterns.length > 0) {
    try {
      custom = new RegExp(`(?:${patterns.join("|")})`);
    } catch {
      throw new Error("other.yaml 的 disableAdopt 包含无效的正则表达式。");
    }
  }
  const tips = new Map<number, number>();

  async function blocked(event: MessageEvent): Promise<boolean> {
    if (!enabled || event.message_type !== "private" || event.isMaster || isMilkyOwnerSession(event)) return false;
    if (event.groupRequestScope === "milky" && event.canReviewGroupRequests === true && groupReviewEntry.test(event.msg)) return false;
    const files = typeof event.message === "string" ? [] : event.message.filter(({ type }) => type === "file");
    const text = event.raw_message || event.msg;
    const allowed = files.length > 0
      ? files.every(({ name, file }) => {
        const filename = typeof name === "string" ? name : file;
        return typeof filename === "string" && allowedFile.test(filename);
      })
      : legacyEntry.test(text) || accountEntry.test(event.msg) || gachaImportEntry.test(event.msg) || custom?.test(text);
    if (allowed) return false;

    const { user_id: userId, self_id: selfId } = event;
    if (!tip || userId === undefined || userId === selfId) return true;
    const now = performance.now();
    for (const [id, until] of tips) {
      if (until > now) break;
      tips.delete(id);
    }
    if (tips.has(userId)) return true;
    tips.set(userId, now + cooldownMs);
    if (tips.size > maxCooldownEntries) tips.delete(tips.keys().next().value!);
    if (!claimTip || await claimTip(userId).catch(() => true)) await event.reply(tip);
    return true;
  }

  async function blockedPoke(event: Pick<MessageEvent, "isMaster" | "reply">): Promise<boolean> {
    if (!enabled || event.isMaster) return false;
    if (tip) await event.reply(tip);
    return true;
  }

  return { disabled: enabled, blocked, blockedPoke };
}
