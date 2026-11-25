import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { readLocalConfig } from "./config.ts";
import { isMilkyOwnerSession } from "./command-permissions.ts";
import { normalizeGameCommand } from "./command-prefix.ts";
import type { MessageEvent } from "./messages.ts";
import { isSystemHelpAlias } from "../plugins/system/help-command.ts";
import { isMiyousheWebCommand } from "./miyoushe-web.ts";

const legacyEntry = /ltoken|_MHYUUID|authkey=|导出记录|(?:记录|安卓|苹果|ck|cookie|体力)帮助|^#?帮助$|^#*(?:删除|我的)ck$|^#(?:我的)?(?:uid|UID)[0-9]{0,2}$/u;
const accountEntry = /^#(?:登录列表|账号列表|(?:清除|删除)(?:登录|扫码登录|[cC]ookie)[0-9]{0,2})$/u;
const gachaImportEntry = /^#?(?:原神|\*|星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)?(?:强制)?导入记录(?:json)?(?:[1-9]\d{0,2})?$/u;
const zzzLinkPrefix = "(?:[#/]?(?:zzz|绝区零|绝区)(?:zzz|绝区零)?|#?[%％](?:zzz|绝区零|绝区)?)";
export const zzzLinkEntry = new RegExp(`^${zzzLinkPrefix}((?:获取)?抽卡链接(?:[1-9]\\d{0,2})?)$`, "iu");
export const starRailLinkEntry = /^#?(?:\*|星穹铁道|崩坏星穹铁道|星铁|星轨|穹轨|星穹|崩铁|铁道)+\s*抽卡链接(?:绑定)?([1-9]\d{0,2})?$/u;

export function isStarRailGachaLinkMessage(text: string) {
  if (!/^https?:\/\/[^/?#\s]+\/common\/gacha_record\/api\/get(?:Ld)?GachaLog(?:[/?#]|$)/iu.test(text.trim())) return false;
  const url = URL.parse(text.trim());
  return !!url && (url.hostname === "public-operation-hkrpg.mihoyo.com" ||
    url.hostname === "public-operation-hkrpg-sg.hoyoverse.com" ||
    url.searchParams.getAll("game_biz").some(game => game === "hkrpg_cn" || game === "hkrpg_global"));
}
const zzzLinkedViewEntry = new RegExp(`^${zzzLinkPrefix}逐抽记录(?:[1-9]\\d{0,2})?$`, "iu");
const groupReviewEntry = /^#(?:入群申请|同意入群|拒绝入群)(?:\s|$)/u;
const allowedFile = /\.(?:txt|xlsx|json)$/iu;
export const defaultPrivateAccessMessage = $t("lib.private-access.text_25aeaf4e0b");
const cooldownMs = 10_000;
const maxCooldownEntries = 10_000;

type ClaimTip = (userId: number) => Promise<boolean>;

export function privateAccessPatterns(config: Readonly<Record<string, unknown>>): string[] {
  const configured = Object.hasOwn(config, "disableAdopt") ? config.disableAdopt : ["stoken"];
  return Array.isArray(configured)
    ? configured.filter((entry): entry is string => typeof entry === "string" && entry !== "") : [];
}

export function privateAccessPolicy(config: Readonly<Record<string, unknown>>) {
  const enabled = Boolean(config.disablePrivate);
  const tip = typeof config.disableMsg === "string" ? config.disableMsg : defaultPrivateAccessMessage;
  const patterns = privateAccessPatterns(config);
  let custom: RegExp | undefined;
  if (enabled && patterns.length > 0) {
    try {
      custom = new RegExp(`(?:${patterns.join("|")})`);
    } catch {
      throw new Error($t("lib.private-access.text_fd9d374479"));
    }
  }
  return { enabled, tip, custom };
}

export async function readPrivateAccess(root: URL, claimTip?: ClaimTip, fileWatch = false) {
  const readPolicy = async () => privateAccessPolicy(await readLocalConfig(root, "other"));
  let policy = await readPolicy();
  const tips = new Map<number, number>();
  let nextRefresh = performance.now() + 1_000;
  let reloading: Promise<void> | undefined;
  let reloadFailed = false;

  function refresh(force = false): Promise<void> | undefined {
    if (!force && !fileWatch) return;
    if (reloading) return force ? reloading.then(() => refresh(true)) : reloading;
    if (!force && performance.now() < nextRefresh) return;
    reloading = readPolicy().then(candidate => {
      policy = candidate;
      reloadFailed = false;
    }).catch(() => {
      if (!reloadFailed) console.warn($t("lib.private-access.text_62d721dc91"));
      reloadFailed = true;
    }).finally(() => {
      nextRefresh = performance.now() + 1_000;
      reloading = undefined;
    });
    return reloading;
  }

  async function blocked(event: MessageEvent): Promise<boolean> {
    if (event.message_type !== "private" || event.isMaster || isMilkyOwnerSession(event)) return false;
    await refresh();
    const { enabled, tip, custom } = policy;
    if (!enabled) return false;
    if (event.groupRequestScope === "milky" && event.canReviewGroupRequests === true && groupReviewEntry.test(event.msg)) return false;
    const files = typeof event.message === "string" ? [] : event.message.filter(({ type }) => type === "file");
    const text = event.raw_message || event.msg;
    const command = normalizeGameCommand(event).msg;
    const help = isSystemHelpAlias(command) || command === "#自动签到帮助";
    const allowed = files.length > 0
      ? files.every(({ name, file }) => {
        const filename = typeof name === "string" ? name : file;
        return typeof filename === "string" && allowedFile.test(filename);
      })
      : isMiyousheWebCommand(event.msg) || help || legacyEntry.test(text) || accountEntry.test(event.msg) || gachaImportEntry.test(event.msg) ||
        zzzLinkEntry.test(event.msg) || zzzLinkedViewEntry.test(event.msg) || starRailLinkEntry.test(event.msg) || custom?.test(text);
    if (allowed) return false;
    if (event.isDelegated) return true;

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

  async function blockedPoke(event: Pick<MessageEvent, "isMaster" | "reply">, quiet = false): Promise<boolean> {
    if (event.isMaster) return false;
    await refresh();
    const { enabled, tip } = policy;
    if (!enabled) return false;
    if (tip && !quiet) await event.reply(tip);
    return true;
  }

  async function allowsFileNotice(isMaster: boolean, name: string): Promise<boolean> {
    if (isMaster) return true;
    await refresh();
    return !policy.enabled || allowedFile.test(name);
  }

  return { get disabled() { return policy.enabled; }, refresh, blocked, blockedPoke, allowsFileNotice };
}
