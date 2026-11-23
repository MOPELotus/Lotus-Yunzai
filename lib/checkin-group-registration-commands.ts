import { MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import { renderStatusCard } from "@lotus-yunzai/skia/status-card";
import type { CommandContext, CommandModule } from "./commands.ts";
import { segment } from "./messages.ts";
import { isCheckinCommandOwner } from "./command-permissions.ts";

const register = /^#注册本群签到([1-9]\d{0,2})?$/u;
const title = "注册本群签到";
const cannotRead = "无法读取本群成员列表，暂时不能批量注册签到。";
const skipLabels = {
  missing: "未找到 profile",
  "login-required": "缺少 cookie/stoken",
  changed: "档案已变化，请重试",
  failed: "暂时无法保存档案",
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
    const lead = `Lotus-Yunzai 签到 · ${badge}\n${message}`;
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
      if (profileId > MAX_PROFILE_ID) return "档案编号须在 1 到 255 之间。";
      const { group_id: groupId, user_id: userId, listCheckinGroupMembers } = context;
      if (context.message_type !== "group" || !isQq(groupId) || !isQq(userId)) {
        return "请在目标群内执行 #注册本群签到。普通用户可在目标群发送 #绑定通知群。";
      }
      if (!canRegister({ ...context, isMaster: isCheckinCommandOwner(context) })) {
        return "当前会话无权为本群批量注册签到。普通用户可发送 #绑定通知群。";
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

      const group = `群号：${groupId}`;
      let available;
      try {
        const allowed = new Set(names.keys());
        available = new Map((await profiles.listCheckinProfiles(allowed, profileId))
          .filter(profile => profile.profileId === profileId && allowed.has(profile.qq)).map(profile => [profile.qq, profile]));
      } catch {
        return card("失败", "暂时无法读取本群的签到档案。", [group]);
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
            if (!latest.loggedIn) throw new ProfileError("login-required", "档案尚未登录。");
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
        const label = `${name ?? "群成员"} (${qq})`;
        if (status === "updated" || status === "existing") {
          counts[status]++;
          if (done.length < 10) done.push(`${label}：${status === "updated" ? "已注册" : "已存在"} P${profileId}`);
        } else {
          counts.skipped++;
          if (skipped.length < 6) skipped.push(`${label}：跳过 · ${skipLabels[status]}`);
        }
      }
      return card(`+${counts.updated}`, "只为本群已登录的指定档案注册签到通知。", [
        group, `profile：P${profileId}`, `群成员：${names.size}`,
        `注册/已有/跳过：${counts.updated}/${counts.existing}/${counts.skipped}`,
        ...(counts.schedule ? [`签到计划暂未更新：${counts.schedule} 个档案`] : []),
        "明细：注册/已有前10条，跳过前6条", ...done, ...skipped,
      ]);
    },
  };
}
