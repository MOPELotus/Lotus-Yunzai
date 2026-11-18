import { createProfileStore, ProfileError } from "@lotus-yunzai/account";
import type { CommandContext, CommandModule } from "./commands.ts";

export function accountCommands(directory?: string): CommandModule {
  const profiles = createProfileStore(directory);
  return {
    name: "@lotus-yunzai/account",
    commands: {
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
