import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createProfileStore, MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import type { CheckinScheduleProfile } from "./checkin-schedule-plan.ts";
import type { CommandContext, CommandModule, CommandReply } from "./commands.ts";
import { isCheckinCommandOwner } from "./command-permissions.ts";
import { checkinSettingsNickname } from "./checkin-profile-commands.ts";

const register = /^#注册自动签到([1-9]\d{0,2})?$/u;

export const checkinStatusCommand = "#签到状态";
export const unregisterCheckinCommand = "#删除签到";

interface CheckinSession {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

const domesticGames = [
  ["genshin", $t("lib.checkin-registration-commands.text_d1597c51ed")], ["honkai_sr", $t("lib.checkin-registration-commands.text_a2927891f0")], ["zzz", $t("lib.checkin-registration-commands.text_b1110352c9")],
  ["honkai3rd", $t("lib.checkin-registration-commands.text_6d3d8653d7")], ["honkai2", $t("lib.checkin-registration-commands.text_7deeae4b7e")], ["tears_of_themis", $t("lib.checkin-registration-commands.text_a6e4fbed57")],
] as const;

export function checkinStatus(directory: string | undefined) {
  const profiles = createProfileStore(directory);
  return async (qq: string, { isCurrent }: Pick<CheckinSession, "isCurrent">) => {
    let ids: number[];
    if (!isCurrent()) return;
    try {
      ids = await profiles.listIds(qq);
    } catch {
      if (isCurrent()) return $t("lib.checkin-registration-commands.text_7ee042e03c");
      return;
    }
    let bound = 0;
    let unreadable = 0;
    const registered: string[] = [];
    for (const id of ids) {
      if (!isCurrent()) return;
      try {
        const { enabled, loggedIn, games, communityForums } = await profiles.checkinSettings(qq, id);
        if (loggedIn) bound++;
        if (!enabled) continue;
        const selected = domesticGames.filter(([game]) => games[game]?.enabled).map(([, name]) => name).join("、");
        const scopes = [selected || $t("lib.checkin-registration-commands.text_48847ce750"), communityForums.length ? $t("lib.checkin-registration-commands.text_a0a51a4f5c") : "", loggedIn ? "" : $t("lib.checkin-registration-commands.text_b50ba41408")].join("");
        registered.push($t("lib.checkin-registration-commands.text_97df6735fe", { "id": id, "scopes": scopes }));
      } catch { unreadable++; }
    }
    if (!isCurrent()) return;
    if (unreadable && unreadable === ids.length) return $t("lib.checkin-registration-commands.text_7ee042e03c");
    const lines = [$t("lib.checkin-registration-commands.text_0f3d1b5e02", { "bound": bound, "length": registered.length }), ...registered];
    if (!bound) lines.push($t("lib.checkin-registration-commands.text_51a7eea04b"));
    else if (!registered.length) lines.push($t("lib.checkin-registration-commands.text_8636a1b569"));
    if (unreadable) lines.push($t("lib.checkin-registration-commands.text_4e5abb06d6", { "unreadable": unreadable }));
    return lines.join("\n");
  };
}

export function checkinUnregistration(directory: string | undefined, reconcilePlans: () => Promise<void>) {
  const profiles = createProfileStore(directory);
  return async (qq: string, { signal, isCurrent }: CheckinSession) => {
    let disabled = 0;
    let failed = 0;
    let ids: number[];
    if (!isCurrent()) return;
    try {
      ids = await profiles.listIds(qq);
    } catch {
      if (isCurrent()) return $t("lib.checkin-registration-commands.text_7ee042e03c");
      return;
    }
    for (const id of ids) {
      if (!isCurrent()) break;
      try {
        const current = await profiles.checkinSettings(qq, id);
        if (!current.enabled) continue;
        if (!isCurrent()) break;
        const change = await profiles.setCheckinEnabled(qq, id, current.revision, false, signal, isCurrent);
        if (change.changed) disabled++;
      } catch (error) {
        if (!isCurrent()) break;
        if (!(error instanceof ProfileError && error.code === "missing")) failed++;
      }
    }
    let planPending = false;
    if (disabled) {
      try { await reconcilePlans(); }
      catch { planPending = true; }
    }
    if (!isCurrent()) return;
    if (!disabled) return failed ? $t("lib.checkin-registration-commands.text_d66da44236") : $t("lib.checkin-registration-commands.text_edbea1acbb");
    const lines = [$t("lib.checkin-registration-commands.text_8b9d3060de", { "disabled": disabled }),
      $t("lib.checkin-registration-commands.text_c09281f8cf")];
    if (failed) lines.push($t("lib.checkin-registration-commands.text_039ed664c0", { "failed": failed }));
    if (planPending) lines.push($t("lib.checkin-registration-commands.text_59a3fb3ede"));
    return lines.join("\n");
  };
}

export function checkinRegistrationCommands(directory: string | undefined, signal: AbortSignal, {
  canRegister, addRegisteredProfile, viewProfile,
}: {
  readonly canRegister: (context: CommandContext) => boolean;
  readonly addRegisteredProfile: (profile: CheckinScheduleProfile) => Promise<void>;
  readonly viewProfile: (profileId: number, context: CommandContext) => CommandReply | Promise<CommandReply>;
}): CommandModule {
  const profiles = createProfileStore(directory);
  return {
    name: "@lotus-yunzai/checkin-registration", commands: {},
    async fallback(_message, context) {
      const match = register.exec(context.normalizedMessage);
      if (!match || signal.aborted) return;
      const profileId = Number(match[1] ?? 1);
      if (profileId > MAX_PROFILE_ID) return $t("lib.checkin-registration-commands.text_3dd62228d2");
      if (!context.user_id || !Number.isSafeInteger(context.user_id) || context.user_id < 1) {
        return $t("lib.checkin-registration-commands.text_bcfa35434f");
      }
      if (!canRegister({ ...context, isMaster: isCheckinCommandOwner(context) })) return $t("lib.checkin-registration-commands.text_94faea8ae1");
      const qq = String(context.user_id);
      let saved = false;
      try {
        const state = await profiles.checkinSettings(qq, profileId);
        if (!state.loggedIn) return $t("lib.checkin-registration-commands.text_76720712c8", { "profileId": profileId });
        if (signal.aborted) return;
        const updated = await profiles.setCheckinEnabled(qq, profileId, state.revision, true,
          signal, undefined, () => checkinSettingsNickname(context));
        saved = true;
        const current = await profiles.checkinSettings(qq, profileId);
        if (signal.aborted) return;
        if (current.revision !== updated.revision) return $t("lib.checkin-registration-commands.text_fa4505e2c7");
        await addRegisteredProfile({ qq, profileId, name: current.displayName, enabled: current.enabled, schedule: current.schedule });
        if (signal.aborted) return;
        return viewProfile(profileId, context);
      } catch (error) {
        if (signal.aborted) return;
        if (saved) return $t("lib.checkin-registration-commands.text_b396f6ac98", { "profileId": profileId });
        if (error instanceof ProfileError && (error.code === "missing" || error.code === "login-required")) {
          return $t("lib.checkin-registration-commands.text_76720712c8", { "profileId": profileId });
        }
        if (error instanceof ProfileError && error.code === "changed") return $t("lib.checkin-registration-commands.text_4ef0078278");
        return $t("lib.checkin-registration-commands.text_0867e4d0d3");
      }
    },
  };
}
