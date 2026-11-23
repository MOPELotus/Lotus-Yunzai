import { createProfileStore } from "@lotus-yunzai/account";
import { createProfileHoyoClient } from "@lotus-yunzai/hoyo-client";

export const accountCookieStatusFeatures = ["[account] 登录状态检查", "account", "@lotus-yunzai/account"] as const;
const command = /^#\s*(?:检查(?:我的)?c(?:oo)?k(?:ie)?(?:状态)?|c(?:oo)?k(?:ie)?(?:状态)?|我的c(?:oo)?k(?:ie)?状态)$/iu;

export function matchesAccountCookieStatus(message: string) {
  return command.test(message.trim());
}

const statusLabels = {
  "not-logged-in": "未登录",
  valid: "有效，已通过米游社在线核验",
  "read-only": "有效，仅保存旧 Cookie，不能自动续期",
  recovered: "已自动续期并通过在线核验",
  expired: "凭据已失效，请重新扫码登录",
  unknown: "暂无法核验，已保留原档案",
} as const;

export function createAccountCookieStatus(profiles: ReturnType<typeof createProfileStore>,
  client = createProfileHoyoClient(profiles)) {
  return async ({ user, signal, isCurrent }: {
    readonly user: number;
    readonly signal: AbortSignal;
    readonly isCurrent: () => boolean;
  }) => {
    const active = () => !signal.aborted && isCurrent();
    const qq = String(user);
    if (!active()) return;
    const ids = await profiles.listIds(qq).catch(() => undefined);
    if (!active()) return;
    if (!ids) return "无法读取本人登录档案，请稍后重试。";
    if (!ids.length) return "没有本人登录档案，可发送 #扫码登录。";

    const results: { id: number; status: keyof typeof statusLabels; revision?: string }[] = [];
    for (const id of ids) {
      if (!active()) return;
      try {
        const { kind, context } = await profiles.cookieCheckContext(qq, id);
        if (!active()) return;
        if (kind === "not-logged-in" || kind === "unverifiable") {
          results.push({ id, status: kind === "unverifiable" ? "unknown" : kind, revision: context.revision });
          continue;
        }
        const verifyReadOnly = kind === "read-only" ? async () => {
          const current = await profiles.cookieCheckContext(qq, id);
          if (!active() || current.context.revision !== context.revision) throw new DOMException("账号档案已变化。", "AbortError");
        } : undefined;
        const { state, revision } = await client.checkLoginCookie(context, { signal, verifyReadOnly });
        results.push({ id, status: state === "valid" && kind === "read-only" ? kind : state, revision });
      } catch {
        if (!active()) return;
        results.push({ id, status: "unknown" });
      }
    }

    const lines = await Promise.all(results.map(async ({ id, status, revision }) => {
      const current = revision && await profiles.cookieCheckContext(qq, id).catch(() => undefined);
      return `档案 ${id} · ${statusLabels[(current && current.context.revision === revision) ? status : "unknown"]}`;
    }));
    if (active()) return ["米游社登录状态", ...lines, "发送 #UID 查看并切换本人角色。需手动清理时输入 #清除登录 和档案编号，例如 #清除登录2。"].join("\n");
  };
}
