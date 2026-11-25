import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import { renderStatusCard } from "@lotus-yunzai/skia/status-card";
import type { CommandContext, CommandModule } from "./commands.ts";
import { segment } from "./messages.ts";
import { isCheckinCommandOwner } from "./command-permissions.ts";

const register = /^#注册本群签到([1-9]\d{0,2})?$/u;
const title = $t("lib.checkin-group-registration-commands.text_d39ecd5125");
const cannotRead = $t("lib.checkin-group-registration-commands.text_131fbfab6c");
const skipLabels = {
  missing: $t("lib.checkin-group-registration-commands.text_47a8562fff"),
  "login-required": $t("lib.checkin-group-registration-commands.text_f353aceb05"),
  changed: $t("lib.checkin-group-registration-commands.text_863e33a765"),
  failed: $t("lib.checkin-group-registration-commands.text_0b0c231cd4"),
} as const;
type Status = "updated" | "existing" | keyof typeof skipLabels;

interface CheckinGroupRegistrationStore {
  listCheckinProfiles(qqs: ReadonlySet<string>, profileId: number): Promise<readonly {
    readonly qq: string; readonly profileId: number; readonly loggedIn: boolean;
  }[]>;
  checkinSettings(qq: string, profileId: number): Promise<{ readonly loggedIn: boolean; readonly revision: string }>;
  registerGroupCheckin(qq: string, profileId: number, revision: string, groupId: number, nickname?: string): Promise<{
    readonly status: "updated" | "existing"; readonly revision: string;
  }>;
}

interface CheckinGroupRegistrationOptions {
  readonly profiles: CheckinGroupRegistrationStore;
  readonly signal: AbortSignal;
  readonly canRegister: (context: CommandContext) => boolean;
  readonly addRegisteredProfile: (qq: string, profileId: number, revision: string) => Promise<void>;
  readonly render?: (...args: Parameters<typeof renderStatusCard>) => Promise<{ readonly png: Buffer }>;
}

function isQq(id: number | undefined): id is number {
  return id !== undefined && Number.isSafeInteger(id) && id > 0;
}

function memberName(value: unknown) {
  return (typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 40) : "") || undefined;
}

function profileFailure(error: unknown): keyof typeof skipLabels {
  if (error instanceof ProfileError &&
      (error.code === "missing" || error.code === "login-required" || error.code === "changed")) return error.code;
  return "failed";
}

export function checkinGroupRegistrationCommands({
  profiles, signal, canRegister, addRegisteredProfile, render = renderStatusCard,
}: CheckinGroupRegistrationOptions): CommandModule {
  async function card(badge: string, message: string, lines: readonly string[]) {
    if (signal.aborted) return;
    const lead = $t("lib.checkin-group-registration-commands.text_71f0e66ea2", { "badge": badge, "message": message });
    try {
      const { png } = await render(title, lead, lines, new Date(), {
        themeDirectory: Bun.env.LOTUS_ATLAS_THEME_DIR?.trim() || undefined, timeZone: "Asia/Shanghai",
      });
      if (signal.aborted) return;
      if (png.byteLength && png.byteLength <= 16 * 1024 * 1024) return segment.image(png);
    } catch {
      // Keep the same result available as text if the renderer is unavailable.
    }
    if (!signal.aborted) return [title, lead, ...lines].join("\n");
  }

  return {
    name: "@lotus-yunzai/checkin-group-registration", commands: {},
    async fallback(_message, context) {
      const match = register.exec(context.normalizedMessage);
      if (!match || signal.aborted) return;
      const profileId = Number(match[1] ?? 1);
      if (profileId > MAX_PROFILE_ID) return $t("lib.checkin-group-registration-commands.text_3dd62228d2");
      const { group_id: groupId, user_id: userId, listCheckinGroupMembers } = context;
      if (context.message_type !== "group" || !isQq(groupId) || !isQq(userId)) {
        return $t("lib.checkin-group-registration-commands.text_61c599670b");
      }
      if (!canRegister({ ...context, isMaster: isCheckinCommandOwner(context) })) {
        return $t("lib.checkin-group-registration-commands.text_4bc8ee4971");
      }
      let members;
      try {
        members = await listCheckinGroupMembers?.();
      } catch {
        if (!signal.aborted) return cannotRead;
        return;
      }
      if (signal.aborted) return;
      if (!Array.isArray(members)) return cannotRead;
      const names = new Map<string, string | undefined>();
      for (const member of members) {
        if (!isQq(member?.id)) return cannotRead;
        const qq = String(member.id);
        if (names.has(qq)) return cannotRead;
        names.set(qq, memberName(member.name));
      }
      if (!names.has(String(userId))) return cannotRead;

      const group = $t("lib.checkin-group-registration-commands.text_64bbec1614", { "groupId": groupId });
      let available;
      try {
        const allowed = new Set(names.keys());
        available = new Map((await profiles.listCheckinProfiles(allowed, profileId))
          .filter(profile => profile.profileId === profileId && allowed.has(profile.qq)).map(profile => [profile.qq, profile]));
      } catch {
        return card($t("lib.checkin-group-registration-commands.text_28384d7afd"), $t("lib.checkin-group-registration-commands.text_d5d2123bd8"), [group]);
      }
      const done: string[] = [];
      const skipped: string[] = [];
      const counts = { updated: 0, existing: 0, skipped: 0, schedule: 0 };
      for (const [qq, name] of names) {
        if (signal.aborted) return;
        const profile = available.get(qq);
        let status: Status = profile ? "login-required" : "missing";
        if (profile?.loggedIn) {
          try {
            const latest = await profiles.checkinSettings(qq, profileId);
            if (signal.aborted) return;
            if (!latest.loggedIn) throw new ProfileError("login-required", $t("lib.checkin-group-registration-commands.text_ec1c922d00"));
            const result = await profiles.registerGroupCheckin(qq, profileId, latest.revision, groupId, name);
            status = result.status;
            if (signal.aborted) return;
            try {
              await addRegisteredProfile(qq, profileId, result.revision);
            } catch {
              counts.schedule++;
            }
          } catch (error) {
            status = profileFailure(error);
          }
        }
        const label = `${name ?? $t("lib.checkin-group-registration-commands.text_9d8692671d")} (${qq})`;
        if (status === "updated" || status === "existing") {
          counts[status]++;
          if (done.length < 10) done.push(`${label}：${status === "updated" ? $t("lib.checkin-group-registration-commands.text_1f4273cab1") : $t("lib.checkin-group-registration-commands.text_e8b1268c1e")} P${profileId}`);
        } else {
          counts.skipped++;
          if (skipped.length < 6) skipped.push($t("lib.checkin-group-registration-commands.text_2f33c7663e", { "label": label, "value2": skipLabels[status] }));
        }
      }
      return card(`+${counts.updated}`, $t("lib.checkin-group-registration-commands.text_fc6249cf92"), [
        group, `profile：P${profileId}`, $t("lib.checkin-group-registration-commands.text_751910cb56", { "size": names.size }),
        $t("lib.checkin-group-registration-commands.text_95ad03dc7a", { "updated": counts.updated, "existing": counts.existing, "skipped": counts.skipped }),
        ...(counts.schedule ? [$t("lib.checkin-group-registration-commands.text_de4da3b3a9", { "schedule": counts.schedule })] : []),
        $t("lib.checkin-group-registration-commands.text_df5115243d"), ...done, ...skipped,
      ]);
    },
  };
}
