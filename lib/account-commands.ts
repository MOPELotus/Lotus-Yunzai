import { createProfileStore, MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import { createProfileHoyoClient } from "@lotus-yunzai/hoyo-client";
import type { CommandContext, CommandHandler, CommandModule } from "./commands.ts";
import { segment } from "./messages.ts";

type RenderRefreshCard = (title: string, lead: string, contents: readonly string[], at: Date) =>
  Promise<{ readonly png: Uint8Array }>;

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

  const accountActions: Record<string, CommandHandler> = { "#刷新cookie": refresh() };
  const aliases: Record<string, string> = { "#账号列表": "#登录列表" };
  for (let id = 0; id <= MAX_PROFILE_ID; id++) {
    const suffix = id === 0 ? "" : String(id);
    const command = `#刷新cookie${suffix}`;
    if (id > 0) accountActions[command] = refresh(id);
    aliases[`#刷新自动签到${suffix}`] = command;
    const syncCommand = `#同步角色${suffix}`;
    accountActions[syncCommand] = sync(id || 1);
    for (const alias of ["UID", "uid"]) aliases[`#同步${alias}${suffix}`] = syncCommand;
    const clearCommand = `#清除登录${suffix}`;
    accountActions[clearCommand] = clear(id || 1);
    for (const verb of ["清除", "删除"]) {
      for (const noun of ["登录", "扫码登录", "cookie", "Cookie"]) {
        const alias = `#${verb}${noun}${suffix}`;
        if (alias !== clearCommand) aliases[alias] = clearCommand;
      }
    }
    for (const alias of ["c", "ck", "Cookie"]) aliases[`#刷新${alias}${suffix}`] = command;
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
        if (!ids.length) return "当前 QQ 尚未创建档案。";

        const lines = ["登录列表"];
        for (const id of ids) {
          try {
            const profile = await profiles.summary(qq, id);
            lines.push(`档案 ${id} · ${profile.loggedIn ? "已登录" : "未登录"}`);
          } catch (error) {
            if (!(error instanceof ProfileError)) throw error;
            lines.push(`档案 ${id} · 无法读取`);
          }
        }
        return lines.join("\n");
      },
    },
  };
}
