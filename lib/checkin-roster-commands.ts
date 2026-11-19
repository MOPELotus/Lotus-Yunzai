import type { createProfileStore } from "@lotus-yunzai/account";
import { renderStatusCard } from "@lotus-yunzai/skia/status-card";
import type { CommandContext, CommandModule } from "./commands.ts";
import { segment } from "./messages.ts";

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
const groupUnavailable = "无法读取本群成员列表，暂时不能生成群内签到名单。";

function validId(id: number | undefined): id is number {
  return id !== undefined && Number.isSafeInteger(id) && id > 0;
}

function memberName(name: string | undefined) {
  const safe = typeof name === "string" ? name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 40) : "";
  return safe || "群成员";
}

export function checkinRosterCommands({ profiles, listMembers, signal, render = renderStatusCard }: CheckinRosterOptions): CommandModule {
  async function describe(profile: Profile) {
    const settings = await profiles.checkinSettings(profile.qq, profile.profileId).catch(() => undefined);
    const login = profile.loggedIn ? "已登录" : "未登录";
    if (!settings) return [login, profile.schedule.mode].join(" · ");
    const games = [
      settings.games.genshin?.enabled ? "原" : "",
      settings.games.honkai_sr?.enabled ? "铁" : "",
      settings.games.zzz?.enabled ? "绝" : "",
    ].filter(Boolean);
    return [login, settings.communityForums.length ? "社区开" : "社区关", games.join("/") || "游戏关", profile.schedule.mode].join(" · ");
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
      if (own.length > limit) details.push(`另有 ${own.length - limit} 个档案`);
      contents.push(`${name} (${qq})\n${own.length} profile · ${details.join("；")}`);
    }
    return card("本群签到名单", `群 ${context.group_id}`, `${byMember.size}/${names.size}`, rows.length
      ? "本群内已注册自动签到的成员如下。" : "本群暂无已注册自动签到的成员。", contents);
  }

  return {
    name: "@lotus-yunzai/checkin-roster",
    commands: {
      async "#签到名单列表"(argument, context) {
        if (argument) return "请直接发送 #签到名单列表。";
        if (signal.aborted) return "";
        const owner = context.isMaster === true;
        try {
          if (!owner && context.message_type === "group") return await groupRoster(context);
          const qq = validId(context.user_id) ? String(context.user_id) : undefined;
          if (!owner && (context.message_type !== "private" || !qq)) return "请从 QQ 会话查看签到名单。";
          const rows = await registered(owner ? undefined : new Set([qq!]));
          const contents: string[] = [];
          for (const row of rows.slice(0, limit)) {
            if (signal.aborted) return "";
            const label = owner ? `QQ ${row.qq} · P${row.profileId}` : `P${row.profileId} · ${row.name || "profile"}`;
            contents.push(`${label}\n${await describe(row)}`);
          }
          if (owner) return card("签到名单", "全局荷花插件 profiles", String(rows.length),
            rows.length ? "当前已注册 profile 如下。" : "当前没有已注册 profile。", contents);
          return card("我的签到名单", `QQ ${qq}`, String(rows.length),
            rows.length ? "你已注册的 profile 如下。" : "你还没有注册自动签到 profile。", contents);
        } catch {
          return signal.aborted ? "" : "签到名单暂时无法读取。";
        }
      },
    },
  };
}
