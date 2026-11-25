import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import type { createProfileStore } from "@lotus-yunzai/account";
import { renderStatusCard } from "@lotus-yunzai/skia/status-card";
import type { CommandContext, CommandModule } from "./commands.ts";
import { segment } from "./messages.ts";
import { isCheckinCommandOwner } from "./command-permissions.ts";

export interface CheckinRosterMember {
  readonly id: number;
  readonly name?: string;
}

interface CheckinRosterOptions {
  readonly profiles: Pick<ReturnType<typeof createProfileStore>, "listCheckinProfiles" | "checkinSettings">;
  readonly listMembers: (context: CommandContext) => Promise<readonly CheckinRosterMember[] | undefined>;
  readonly signal: AbortSignal;
  readonly render?: (...args: Parameters<typeof renderStatusCard>) => Promise<{ readonly png: Buffer }>;
}

type Profile = Awaited<ReturnType<CheckinRosterOptions["profiles"]["listCheckinProfiles"]>>[number];
const limit = 14;
const groupUnavailable = $t("lib.checkin-roster-commands.text_56336e85ec");

function validId(id: number | undefined): id is number {
  return id !== undefined && Number.isSafeInteger(id) && id > 0;
}

function memberName(name: string | undefined) {
  const safe = typeof name === "string" ? name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 40) : "";
  return safe || $t("lib.checkin-roster-commands.text_9d8692671d");
}

export function checkinRosterCommands({ profiles, listMembers, signal, render = renderStatusCard }: CheckinRosterOptions): CommandModule {
  async function describe(profile: Profile) {
    const settings = await profiles.checkinSettings(profile.qq, profile.profileId).catch(() => undefined);
    const login = profile.loggedIn ? $t("lib.checkin-roster-commands.text_0a01eee1cd") : $t("lib.checkin-roster-commands.text_c1f6583730");
    if (!settings) return [login, profile.schedule.mode].join(" · ");
    const games = [
      settings.games.genshin?.enabled ? $t("lib.checkin-roster-commands.text_109c3c1f43") : "",
      settings.games.honkai_sr?.enabled ? $t("lib.checkin-roster-commands.text_8f615d2ef8") : "",
      settings.games.zzz?.enabled ? $t("lib.checkin-roster-commands.text_c5d5a1475e") : "",
    ].filter(Boolean);
    return [login, settings.communityForums.length ? $t("lib.checkin-roster-commands.text_8f22dd545c") : $t("lib.checkin-roster-commands.text_d2989be8c8"), games.join("/") || $t("lib.checkin-roster-commands.text_6624c8c184"), profile.schedule.mode].join(" · ");
  }

  async function card(title: string, subtitle: string, count: string, message: string, contents: readonly string[]) {
    if (signal.aborted) return "";
    const lead = `${subtitle} · ${count}\n${message}`;
    try {
      const { png } = await render(title, lead, contents, new Date(), {
        themeDirectory: Bun.env.LOTUS_ATLAS_THEME_DIR?.trim() || undefined, timeZone: "Asia/Shanghai",
      });
      if (signal.aborted) return "";
      if (png.byteLength && png.byteLength <= 16 * 1024 * 1024) return segment.image(png);
    } catch {
      // Use the same authorized roster rows when the local renderer fails.
    }
    return signal.aborted ? "" : [title, lead, ...contents].join("\n");
  }

  async function registered(allowed?: ReadonlySet<string>) {
    const rows = await (allowed ? profiles.listCheckinProfiles(allowed) : profiles.listCheckinProfiles());
    return rows.filter(profile => profile.enabled && (!allowed || allowed.has(profile.qq)));
  }

  async function groupRoster(context: CommandContext) {
    if (!validId(context.group_id) || !validId(context.user_id)) return groupUnavailable;
    let members: readonly CheckinRosterMember[] | undefined;
    try {
      members = await listMembers(context);
    } catch {
      return signal.aborted ? "" : groupUnavailable;
    }
    if (signal.aborted) return "";
    if (!members) return groupUnavailable;
    const names = new Map<string, string>();
    for (const member of members) {
      if (validId(member.id) && !names.has(String(member.id))) names.set(String(member.id), memberName(member.name));
    }
    if (!names.has(String(context.user_id))) return groupUnavailable;
    const rows = await registered(new Set(names.keys()));
    const byMember = new Map<string, Profile[]>();
    for (const profile of rows) {
      const list = byMember.get(profile.qq);
      if (list) list.push(profile);
      else byMember.set(profile.qq, [profile]);
    }
    const contents: string[] = [];
    for (const [qq, name] of names) {
      if (signal.aborted) return "";
      if (contents.length >= limit) break;
      const own = byMember.get(qq);
      if (!own) continue;
      const details = [];
      for (const profile of own.sort((left, right) => left.profileId - right.profileId).slice(0, limit)) {
        if (signal.aborted) return "";
        details.push(`P${profile.profileId} ${await describe(profile)}`);
      }
      if (own.length > limit) details.push($t("lib.checkin-roster-commands.text_f5130a3a8a", { "value1": own.length - limit }));
      contents.push(`${name} (${qq})\n${own.length} profile · ${details.join("；")}`);
    }
    return card($t("lib.checkin-roster-commands.text_2cc25d723c"), $t("lib.checkin-roster-commands.text_bf1ff3314a", { "group_id": context.group_id }), `${byMember.size}/${names.size}`, rows.length
      ? $t("lib.checkin-roster-commands.text_cf1424d47c") : $t("lib.checkin-roster-commands.text_59418dae23"), contents);
  }

  return {
    name: "@lotus-yunzai/checkin-roster",
    commands: {
      async "#签到名单列表"(argument, context) {
        if (argument) return $t("lib.checkin-roster-commands.text_fd659fbca0");
        if (signal.aborted) return "";
        const owner = isCheckinCommandOwner(context);
        try {
          if (!owner && context.message_type === "group") return await groupRoster(context);
          const qq = validId(context.user_id) ? String(context.user_id) : undefined;
          if (!owner && (context.message_type !== "private" || !qq)) return $t("lib.checkin-roster-commands.text_b59163c196");
          const rows = await registered(owner ? undefined : new Set([qq!]));
          const contents: string[] = [];
          for (const row of rows.slice(0, limit)) {
            if (signal.aborted) return "";
            const label = owner ? `QQ ${row.qq} · P${row.profileId}` : `P${row.profileId} · ${row.name || "profile"}`;
            contents.push(`${label}\n${await describe(row)}`);
          }
          if (owner) return card($t("lib.checkin-roster-commands.text_386a27b6cf"), $t("lib.checkin-roster-commands.text_e6262a56b8"), String(rows.length),
            rows.length ? $t("lib.checkin-roster-commands.text_e8628bf27f") : $t("lib.checkin-roster-commands.text_6e4612f14f"), contents);
          return card($t("lib.checkin-roster-commands.text_63b85ff9f0"), `QQ ${qq}`, String(rows.length),
            rows.length ? $t("lib.checkin-roster-commands.text_307304a91c") : $t("lib.checkin-roster-commands.text_c3f87a5b4b"), contents);
        } catch {
          return signal.aborted ? "" : $t("lib.checkin-roster-commands.text_3ab24605ae");
        }
      },
    },
  };
}
