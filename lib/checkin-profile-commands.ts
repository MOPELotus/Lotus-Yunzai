import { createProfileStore, MAX_PROFILE_ID, ProfileError,
  type ProfileCheckinSettingsChange } from "@lotus-yunzai/account";
import type { CommandContext, CommandModule, CommandReply } from "./commands.ts";

const toggle = /^#(启用|开启|关闭|禁用)((?:原神|星铁|崩铁|绝区零|绝|未定事件簿|未定|崩坏3|崩三)(?:游戏)?|全部游戏)签到([1-9]\d{0,2})?$/u;
const notifyToggle = /^#(启用|开启|关闭|禁用)签到通知([1-9]\d{0,2})?$/u;
const communityToggle = /^#(启用|开启|关闭|禁用)社区签到([1-9]\d{0,2})?$/u;
const notifyPrefer = /^#设置通知(私聊|群聊)([1-9]\d{0,2})?$/u;
const bindGroup = /^#(?:绑定|设置|切换)(?:通知群|签到通知群|本群通知)([1-9]\d{0,2})?$/u;
const inheritTime = /^#(?:跟随|继承)(?:全局)?签到时间([1-9]\d{0,2})?$/u;
const randomTime = /^#随机签到时间([1-9]\d{0,2})?$/u;
const fixedTime = /^#(?:固定|设置)签到时间([1-9]\d{0,2})?\s+(\d{1,2}:\d{2})$/u;
type CheckinGame = Extract<ProfileCheckinSettingsChange, { type: "game" }>["game"];
const games = new Map<string, CheckinGame>([
  ["原神", "gs"], ["星铁", "sr"], ["崩铁", "sr"], ["绝区零", "zzz"], ["绝", "zzz"],
  ["未定事件簿", "nxx"], ["未定", "nxx"],
  ["崩坏3", "bh3"], ["崩三", "bh3"],
]);

function isEnabled(action: string) {
  return action === "启用" || action === "开启";
}

function matchSettings(message: string, groupId: number | undefined) {
  function action(id: string | undefined, change: ProfileCheckinSettingsChange) {
    return { id: Number(id || 1), change };
  }
  const notification = notifyToggle.exec(message);
  if (notification) return action(notification[2], { type: "notify-enabled", enabled: isEnabled(notification[1]!) });
  const community = communityToggle.exec(message);
  if (community) return action(community[2], { type: "community", enabled: isEnabled(community[1]!) });
  const game = toggle.exec(message);
  if (game) {
    const enabled = isEnabled(game[1]!);
    const key = game[2]!;
    if (key === "全部游戏") return action(game[3], { type: "all-games", enabled });
    const code = games.get(key.replace(/游戏$/u, ""));
    if (code) return action(game[3], { type: "game", game: code, enabled });
  }
  const preference = notifyPrefer.exec(message);
  if (preference) return action(preference[2], preference[1] === "群聊"
    ? { type: "notify-preference", prefer: "group", groupId } : { type: "notify-preference", prefer: "private" });
  const binding = bindGroup.exec(message);
  if (binding) return groupId ? action(binding[1], { type: "bind-notify-group", groupId }) : "请在要接收通知的群里发送绑定指令。";
  const inherit = inheritTime.exec(message);
  if (inherit) return action(inherit[1], { type: "schedule", mode: "inherit" });
  const random = randomTime.exec(message);
  if (random) return action(random[1], { type: "schedule", mode: "random" });
  const fixed = fixedTime.exec(message);
  if (fixed) return action(fixed[1], { type: "schedule", mode: "fixed", time: fixed[2]! });
}

export function checkinProfileCommands(directory: string | undefined, signal: AbortSignal, {
  reconcilePlans, viewProfile,
}: {
  readonly reconcilePlans: () => Promise<void>;
  readonly viewProfile: (profileId: number, context: CommandContext) => CommandReply | Promise<CommandReply>;
}): CommandModule {
  const profiles = createProfileStore(directory);
  return {
    name: "@lotus-yunzai/checkin-profile", commands: {},
    async fallback(_message, context) {
      if (signal.aborted) return;
      const group = context.group_id;
      const groupId = context.message_type === "group" && group !== undefined && Number.isSafeInteger(group) && group > 0
        ? group : undefined;
      const match = matchSettings(context.normalizedMessage, groupId);
      if (typeof match === "string" || !match) return match;
      const { id, change } = match;
      if (id > MAX_PROFILE_ID) return "档案编号须在 1 到 255 之间。";
      if (!context.user_id || !Number.isSafeInteger(context.user_id) || context.user_id < 1) return "请从对应的 QQ 会话设置签到。";
      const qq = String(context.user_id);
      let saved = false;
      try {
        const current = await profiles.checkinSettings(qq, id);
        if (signal.aborted) return;
        const result = await profiles.setProfileCheckinSettings(qq, id, current.revision, change);
        saved = true;
        if (result.changed && change.type === "schedule") await reconcilePlans();
        if (signal.aborted) return;
        return await viewProfile(id, context);
      } catch (error) {
        if (signal.aborted) return;
        if (saved) return `档案 ${id} 的签到设置已保存，暂时无法更新计划或显示资料卡。`;
        if (error instanceof ProfileError) {
          if (error.code === "missing" || error.code === "login-required") return `请先登录 profile ${id}。`;
          if (error.code === "changed") return "档案设置已变化，请重试。";
          if (change.type === "schedule" && change.mode === "fixed") return "签到时间需为 0:00 到 23:59。";
        }
        return "暂时无法保存签到设置。";
      }
    },
  };
}
