import { createProfileStore, MAX_PROFILE_ID, ProfileError, profileGames } from "@lotus-yunzai/account";
import { createProfileHoyoClient } from "@lotus-yunzai/hoyo-client";
import type { CommandContext, CommandHandler, CommandModule } from "./commands.ts";
import { segment } from "./messages.ts";

type RenderRefreshCard = (title: string, lead: string, contents: readonly string[], at: Date) =>
  Promise<{ readonly png: Uint8Array }>;

const roleLabels = { gs: "原神", sr: "星铁", zzz: "绝区零" } as const;
const checkinItems = [
  ["原神", "genshin", 2], ["崩坏2", "honkai2", 3], ["崩坏3", "honkai3rd", 1],
  ["未定事件簿", "tears_of_themis", 4], ["大别野", "", 5], ["星铁", "honkai_sr", 6],
  ["绝区零", "zzz", 8], ["因缘精灵", "hna", 9], ["星布谷地", "", 10],
] as const;
const switchState = (enabled: boolean) => enabled ? "开启" : "关闭";
const refreshAliases = ["自动签到", "c", "ck", "Cookie"];
const clearVerbs = ["清除", "删除"];
const clearNouns = ["登录", "扫码登录", "cookie", "Cookie"];
const loginMutation = new RegExp(`^(?:#刷新(?:cookie|${refreshAliases.join("|")})|` +
  `#(?:${clearVerbs.join("|")})(?:${clearNouns.join("|")}))(?:[1-9]\\d{0,2})?(?:\\s|$)`, "u");

export function isAccountLoginMutation(command: string) { return loginMutation.test(command); }

export function accountCommands(
  directory: string | undefined,
  canRefresh: (context: CommandContext) => boolean,
  makeClient = createProfileHoyoClient,
  renderRefreshCard?: RenderRefreshCard,
): CommandModule {
  const profiles = createProfileStore(directory);
  const client = makeClient(profiles);

  function refresh(profileId?: number): CommandHandler {
    return async (argument, context) => {
      if (argument) return "用法：#刷新cookie 或 #刷新cookie2";
      if (context.user_id === undefined) return "请从 QQ 会话发送刷新指令。";
      if (!canRefresh(context)) return "当前不允许刷新登录信息，请联系机器人主人。";

      const qq = String(context.user_id);
      const ids = profileId === undefined ? await profiles.listIds(qq) : [profileId];
      if (!ids.length) return "当前 QQ 尚未创建档案。";
      const title = "Cookie 刷新";
      const outcomes: { id: number; message: string }[] = [];
      let refreshed = 0;
      for (const id of ids) {
        try {
          const { rolesSynced } = await client.refreshProfile(await profiles.accountContext(qq, id));
          refreshed++;
          outcomes.push({ id, message: rolesSynced ? "刷新成功" : "刷新成功，角色同步失败" });
        } catch {
          outcomes.push({ id, message: "刷新失败，请确认登录状态后重试" });
        }
      }
      if (renderRefreshCard) {
        const message = profileId === undefined
          ? (refreshed === ids.length
            ? "已按 profile 粒度刷新当前 QQ 的登录信息。"
            : `已按 profile 粒度处理当前 QQ 的登录信息，刷新成功 ${refreshed}/${ids.length}。`)
          : (refreshed ? `已刷新 profile ${profileId} 的登录信息。` : `profile ${profileId} 的登录信息未能刷新。`);
        try {
          const contents = outcomes.map(({ id, message }) => `Profile ${id}：${message}`);
          const { png } = await renderRefreshCard(title, `QQ ${qq}\n${message}`, contents, new Date());
          if (png.byteLength) return segment.image(png);
        } catch {
          // The refresh results stay available if the optional card cannot be drawn.
        }
      }
      return [title, ...outcomes.map(({ id, message }) => `档案 ${id} · ${message}`)].join("\n");
    };
  }

  function sync(id: number): CommandHandler {
    return async (argument, context) => {
      if (argument) return "用法：#同步角色 或 #同步角色2";
      if (context.user_id === undefined) return "请从 QQ 会话发送同步角色指令。";

      try {
        const profile = await profiles.accountContext(String(context.user_id), id);
        const roles = await client.syncRoles(profile, canRefresh(context));
        return `档案 ${id} 角色已同步。原神 ${roles.gs.length}，星铁 ${roles.sr.length}，绝区零 ${roles.zzz.length}。`;
      } catch {
        return `无法同步档案 ${id} 的角色，请确认登录状态后重试。`;
      }
    };
  }

  function clear(id: number): CommandHandler {
    return async (argument, context) => {
      if (argument) return "用法：#清除登录 或 #清除登录2";
      if (context.user_id === undefined) return "请从 QQ 会话发送清除登录指令。";

      try {
        await profiles.clearLogin(String(context.user_id), id);
        return `档案 ${id} 的登录信息已清除，设备和角色设置已保留。`;
      } catch {
        return `无法清除档案 ${id} 的登录信息，请检查档案是否存在。`;
      }
    };
  }

  function describe(id: number): CommandHandler {
    return async (argument, context) => {
      if (argument) return "用法：#配置 或 #配置2";
      if (!context.user_id || !Number.isSafeInteger(context.user_id) || context.user_id < 1) {
        return "请从 QQ 会话发送配置查询指令。";
      }
      const qq = String(context.user_id);
      const profile = await profiles.describe(qq, id).catch(() => undefined);
      if (!profile?.loggedIn) return `[account] 请先扫码登录 profile ${id}。`;
      const mode = !profile.enabled ? "仅手动" : profile.schedule.mode === "fixed" ? profile.schedule.fixedTime || "固定"
        : profile.schedule.mode === "random" ? "随机" : "跟随全局";
      const device = profile.deviceBound ? profile.device.name || "已绑定" : profile.device.generated
        ? [`自动设备 · ${profile.device.name || "Lotus-Yunzai"}`, !profile.device.hasFingerprint && "FP 待获取"].filter(Boolean).join(" · ")
        : "未绑定";
      const settings: { label: string; value: string }[] = checkinItems.map(([label, game, forum]) => ({
        label, value: `游戏 ${game ? switchState(profile.gameCheckin[game] === true) : "无"} · 社区 ${switchState(profile.communityCheckin.includes(forum))}`,
      }));
      if (profile.international.enabled) settings.push({
        label: "国际服", value: `${profile.international.language} · ${profile.international.hasCookie ? "已保存" : "未保存"}`,
      });
      if (profile.cloud.length) settings.push({
        label: "云游戏", value: profile.cloud.map(({ game, hasToken }) =>
          `${game === "genshin" ? "云原神" : "云绝区零"}${hasToken ? "" : "（缺凭据）"}`).join(" / "),
      });
      const roleGroups = profileGames.map((game) => ({
        label: roleLabels[game],
        rows: profile.roles[game].map((role) => ({
          uid: role.uid, name: role.nickname || role.regionName, level: role.level, active: role.uid === profile.activeRoles[game],
          avatar: role.avatar,
        })),
      }));
      const account = [
        { label: "通行证", value: profile.passport },
        { label: "Cookie", value: profile.hasCookie ? "已保存" : "未保存" },
        { label: "SToken", value: profile.hasStoken ? "已保存" : "未保存" },
        { label: "设备信息", value: device },
      ];
      const title = profile.nickname || `QQ ${qq}`;
      const subtitle = `profile ${id} · ${profile.name || "default"}`;
      const summary = `签到模式：${mode} · 通知：${switchState(profile.notifications)}。敏感字段已脱敏显示。`;
      const warnings = [
        ...(profile.rolesPending ? ["角色暂未同步，可发送 #同步角色 后重试。"] : []),
        ...(!profile.device.hasFingerprint ? ["社区任务需要配对的设备 ID 与 FP，也可绑定真机。"] : []),
      ];
      try {
        const { renderProfileCard } = await import("@lotus-yunzai/skia/profile");
        const { loadProfileRoleArtwork } = await import("./profile-role-artwork.ts");
        const artwork = await loadProfileRoleArtwork(roleGroups.flatMap(({ rows }) => rows.map(({ avatar }) => avatar)));
        const { png } = await renderProfileCard({
          title, subtitle, summary, account, settings, warnings,
          roleGroups: roleGroups.map(({ label, rows }) => ({
            label, rows: rows.map(({ avatar, ...row }) => ({ ...row, ...(avatar ? { image: artwork.get(avatar) } : {}) })),
          })),
          generatedAt: new Date().toLocaleString("sv-SE", { hour12: false }),
        }, { resourceDirectory: Bun.env.LOTUS_PASSPORT_QR_RESOURCES || undefined });
        if (png.byteLength) return segment.image(png);
      } catch {
        // Settings stay readable if the original resources are absent.
      }
      return [title, subtitle, summary, ...account.map(({ label, value }) => `${label} · ${value}`),
        ...roleGroups.map(({ label, rows }) => `${label} · ${rows.map(({ uid, active }) => `${uid}${active ? "（当前）" : ""}`).join("、") || "未同步"}`),
        ...settings.map(({ label, value }) => `${label} · ${value}`), ...warnings].join("\n");
    };
  }

  const accountActions: Record<string, CommandHandler> = { "#刷新cookie": refresh() };
  const aliases: Record<string, string> = { "#账号列表": "#登录列表" };
  for (let id = 0; id <= MAX_PROFILE_ID; id++) {
    const suffix = id === 0 ? "" : String(id);
    const command = `#刷新cookie${suffix}`;
    if (id > 0) accountActions[command] = refresh(id);
    const syncCommand = `#同步角色${suffix}`;
    accountActions[syncCommand] = sync(id || 1);
    for (const alias of ["UID", "uid"]) aliases[`#同步${alias}${suffix}`] = syncCommand;
    const clearCommand = `#清除登录${suffix}`;
    accountActions[clearCommand] = clear(id || 1);
    for (const verb of clearVerbs) {
      for (const noun of clearNouns) {
        const alias = `#${verb}${noun}${suffix}`;
        if (alias !== clearCommand) aliases[alias] = clearCommand;
      }
    }
    for (const alias of refreshAliases) aliases[`#刷新${alias}${suffix}`] = command;
    const cardCommand = `#配置${suffix}`;
    accountActions[cardCommand] = describe(id || 1);
    for (const prefix of ["", "原神", "星铁", "绝区零", "zzz", "ZZZ"]) aliases[`#${prefix}设备信息${suffix}`] = cardCommand;
    for (const label of ["资料", "资料卡", "我的配置"]) {
      aliases[`#${label}${suffix}`] = cardCommand;
    }
  }

  return {
    name: "@lotus-yunzai/account",
    aliases,
    commands: {
      ...accountActions,
      async "#登录列表"(argument: string, context: CommandContext) {
        if (argument) return "用法：#登录列表";
        if (context.user_id === undefined) return "请从 QQ 会话发送 #登录列表。";

        const qq = String(context.user_id);
        const ids = await profiles.listIds(qq);
        const items: string[] = [];
        const lines = ["登录列表"];
        for (const id of ids) {
          try {
            const profile = await profiles.describe(qq, id);
            const status = profile.loggedIn ? "已登录" : profile.legacyCookie ? "旧 Cookie（仅查询）" : "未登录";
            const selected = `原${profile.activeRoles.gs || "-"} / 铁${profile.activeRoles.sr || "-"} / 绝${profile.activeRoles.zzz || "-"}`;
            items.push(`Profile ${id}：${status} · ${selected}`);
            lines.push(`档案 ${id} · ${status}`);
          } catch (error) {
            if (!(error instanceof ProfileError)) throw error;
            items.push(`Profile ${id}：无法读取`);
            lines.push(`档案 ${id} · 无法读取`);
          }
        }
        if (renderRefreshCard) {
          const lead = `QQ ${qq}\n${ids.length ? "当前 QQ 已创建的 profile 如下。" : "还没有创建 profile。"}`;
          try {
            const { png } = await renderRefreshCard("登录列表", lead, items, new Date());
            if (png.byteLength) return segment.image(png);
          } catch {
            // Keep the same list available as text.
          }
        }
        return ids.length ? lines.join("\n") : "当前 QQ 尚未创建档案。";
      },
    },
  };
}
