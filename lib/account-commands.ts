import { createProfileStore, MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import { createProfileHoyoClient } from "@lotus-yunzai/hoyo-client";
import type { CommandContext, CommandHandler, CommandModule } from "./commands.ts";

export function accountCommands(
  directory: string | undefined,
  canRefresh: (context: CommandContext) => boolean,
  makeClient = createProfileHoyoClient,
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
      const lines = ["Cookie 刷新"];
      for (const id of ids) {
        try {
          await client.refreshCredentials(await profiles.accountContext(qq, id));
          lines.push(`档案 ${id} · 刷新成功`);
        } catch {
          lines.push(`档案 ${id} · 刷新失败，请确认登录状态后重试`);
        }
      }
      return lines.join("\n");
    };
  }

  const refreshCommands: Record<string, CommandHandler> = { "#刷新cookie": refresh() };
  const aliases: Record<string, string> = {};
  for (let id = 0; id <= MAX_PROFILE_ID; id++) {
    const suffix = id === 0 ? "" : String(id);
    const command = `#刷新cookie${suffix}`;
    if (id > 0) refreshCommands[command] = refresh(id);
    for (const alias of ["c", "ck", "Cookie"]) aliases[`#刷新${alias}${suffix}`] = command;
  }

  return {
    name: "@lotus-yunzai/account",
    aliases,
    commands: {
      ...refreshCommands,
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
