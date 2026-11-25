import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import type { ManagedUpdateProgress } from "./managed-update-protocol.ts";
import type { MessageEvent } from "./messages.ts";
import { canManagePackages } from "./command-permissions.ts";
import { parseUpdateTarget } from "./update-target.ts";

type RequestUpdate = (event: MessageEvent, requested: string | undefined, quiet: boolean,
  report: (status: ManagedUpdateProgress) => void, all: boolean, force: boolean) => boolean | Promise<boolean>;

const command = /^#(全部)?(安?静)?(强制)?更新/u;
const legacyStarRailWarpUpdate = /^#?(?:\*|星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)抽卡(?:插件)?(强制)?更新$/u;
const quietStatuses = new Set<ManagedUpdateProgress>(["checking", "building", "switching", "current"]);
const replies: Readonly<Record<ManagedUpdateProgress, string>> = {
  checking: $t("lib.update-command.text_4bfc24f08b"),
  building: $t("lib.update-command.text_029f28b6f1"),
  switching: $t("lib.update-command.text_96790a7d94"),
  busy: $t("lib.update-command.text_4bb4fe218d"),
  current: $t("lib.update-command.text_ca9955f4ec"),
  dirty: $t("lib.update-command.text_e55718b0a0"),
  ahead: $t("lib.update-command.text_44001503e0"),
  diverged: $t("lib.update-command.text_e0389507bc"),
  rejected: $t("lib.update-command.text_759c00b5d9"),
  unavailable: $t("lib.update-command.text_3d6415ebf8"),
  "storage-changed": $t("lib.update-command.text_642562fa39"),
  failed: $t("lib.update-command.text_2236b3d59a"),
};

export function describeUpdateProgress(status: ManagedUpdateProgress): string {
  return replies[status];
}

function updatePrefix(message: string): RegExpExecArray | undefined {
  // 旧业务命令停用后仍不应触发仓库更新。
  if (/^#(?:强制)?更新(?:配队|攻略|摩拉)资源(?:\s|$)/u.test(message)) return;
  if (/^#更新\S+(?:攻略[1-7]?|一图流)$/u.test(message.trimEnd())) return;
  if (/^#(?:原神)?更新\S+(?:突破|材料|素材|培养)$/u.test(message.trimEnd())) return;
  if (/^#更新群名片(?:\s|$)/u.test(message)) return;
  if (/^#更新(?:图鉴|抽卡记录(?:[1-9]\d{0,2})?|(?:全部|所有)抽卡记录)$/u.test(message.trimEnd())) return;
  if (/^#更新(?:充值|消费)(?:记录|统计)(?:\s+(?:档案|profile)\s*\d{1,3})?$/iu.test(message.trimEnd())) return;
  if (/^#更新(?:全部)?面板\s*(?:[1-9]\d{0,2}|[1-9]\d{8,9})?$/u.test(message.trimEnd())) return;
  if (/^#(?:强制)?更新(?:所有|角色)*(?:天赋|技能|行迹)(?:\s*(?:(?:档案|profile)\s*)?\d{1,3})?$/iu.test(message.trimEnd())) return;
  if (/^#更新(?:提瓦特)?小助手(?:抽卡|祈愿)?(?:记录|历史)(?:[1-9]\d{0,2})?(?:\s|$)/u.test(message)) return;
  const match = command.exec(message);
  if (!match || (match[1] === undefined && message.startsWith("日志", match[0].length))) return;
  return match;
}

function updateInput(text: string) {
  const message = text.trimStart();
  const legacy = legacyStarRailWarpUpdate.exec(message.trimEnd());
  return legacy ? $t("lib.update-command.text_79a21d49b4", { "value1": legacy[1] ?? "" }) : message;
}

export function isUpdateCommand(text: string): boolean {
  return updatePrefix(updateInput(text)) !== undefined;
}

export function hasValidUpdateTarget(text: string): boolean {
  const message = updateInput(text);
  const match = updatePrefix(message);
  if (!match) return false;
  const requested = parseUpdateTarget(message.slice(match[0].length));
  return requested !== undefined && (match[1] === undefined || requested === "");
}

export function createUpdateCommand(request: RequestUpdate) {
  return async (event: MessageEvent): Promise<void> => {
    const message = updateInput(event.msg);
    const match = updatePrefix(message);
    if (!match) return;
    if (!canManagePackages(event)) {
      await event.reply($t("lib.update-command.text_ee7b348d1b"));
      return;
    }

    const all = match[1] !== undefined;
    const quiet = match[2] !== undefined;
    const force = match[3] !== undefined;
    const requested = parseUpdateTarget(message.slice(match[0].length));
    if (all && requested !== "") {
      await event.reply(force ? $t("lib.update-command.text_197cd5caf2")
        : $t("lib.update-command.text_c3a2df2402"));
      return;
    }
    if (requested === undefined) {
      const example = force ? "#强制更新" : "#更新";
      await event.reply($t("lib.update-command.text_09fe40ea71", { "example": example, "value2": example }));
      return;
    }

    let pending = Promise.resolve();
    const report = (status: ManagedUpdateProgress) => {
      if (quiet && quietStatuses.has(status)) return;
      const reply = force && status === "checking" ? $t("lib.update-command.text_0127364ac8") : replies[status];
      pending = pending.then(async () => { await event.reply(reply); }).catch(() => undefined);
    };
    let sent: boolean;
    try {
      sent = await request(event, requested || undefined, quiet, report, all, force);
    } catch {
      await event.reply($t("lib.update-command.text_8ec36d4e0b"));
      return;
    }
    if (!sent) {
      await event.reply($t("lib.update-command.text_60901977ce"));
      return;
    }
    await pending;
  };
}
