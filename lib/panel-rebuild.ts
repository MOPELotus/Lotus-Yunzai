import { setTimeout } from "node:timers/promises";
import { ProfileError, type createProfileStore } from "@lotus-yunzai/account";
import type { MessageFallback } from "./commands.ts";
import { segment } from "./messages.ts";

export type PanelRebuildGame = "gs" | "sr";
export type PanelRebuilder = (
  qq: string, profileId: number, uid: string, signal: AbortSignal, verifyAuthority: () => void,
) => Promise<boolean>;

type PanelRebuildProfiles = Pick<ReturnType<typeof createProfileStore>, "listCheckinProfiles" | "savedRole">;
type Render = (title: string, lead: string, rows: readonly string[], at: Date) => Promise<{ readonly png: Uint8Array }>;

const command = /^#(?:修复|重建|重刷|清理)(?:原铁|原神星铁|原神和星铁|面板(?:缓存|数据)?|排名数据|个人查询缓存)(?:\s+间隔(\d{1,3}))?$/u;
const gameNames = { gs: "原神", sr: "星铁" };
const reportRows = 14;
const renderReport: Render = async (...args) => {
  const { renderStatusCard } = await import("@lotus-yunzai/skia/status-card");
  return renderStatusCard(...args);
};

export function createPanelRebuild(profiles: PanelRebuildProfiles, signal: AbortSignal, render: Render = renderReport) {
  const providers = new Map<PanelRebuildGame, PanelRebuilder>();
  let rebuilding = false;
  function register(game: PanelRebuildGame, provider: PanelRebuilder) {
    providers.set(game, provider);
    return () => {
      if (providers.get(game) === provider) providers.delete(game);
    };
  }

  const fallback: MessageFallback = async (_message, context) => {
    const request = command.exec(context.normalizedMessage);
    if (!request || signal.aborted) return;
    if (context.message_type !== "private" || context.canManagePackages !== true || context.isDelegated ||
        !context.privateCredentialSignal || context.user_id === undefined || !context.isMaster ||
        !context.isBotMaster(context.user_id)) return "请由机器人主人在已绑定的私聊中重建面板。";
    const active = AbortSignal.any([signal, context.privateCredentialSignal]);
    const requester = context.user_id;
    function verifyAuthority() {
      active.throwIfAborted();
      if (!context.isBotMaster(requester)) throw new Error("机器人主人授权已变更。");
    }
    if (active.aborted) return;
    if (rebuilding) return "原神和星铁面板正在重建，请稍后再试。";
    rebuilding = true;
    try {
      if (!providers.size) return "原神和星铁的面板更新模块尚未加载。";
      const intervalMs = Math.min(60, request[1] === undefined ? 8 : Number(request[1])) * 1000;
      const profilesToRead = await profiles.listCheckinProfiles();
      verifyAuthority();
      const targets = [];
      for (const { qq, profileId, loggedIn } of profilesToRead) {
        if (!loggedIn) continue;
        for (const game of ["gs", "sr"] as const) {
          if (!providers.has(game)) continue;
          verifyAuthority();
          const role = await profiles.savedRole(qq, profileId, game).catch(() => undefined);
          if (role?.region && /^[1-9]\d{8,9}$/u.test(role.uid)) targets.push({ qq, profileId, game, role });
        }
      }
      verifyAuthority();
      if (!targets.length) return "没有可重建的已登录原神或星铁档案。";
      const status = { done: 0, skipped: 0, failed: 0 };
      const rows: string[] = [];
      const finished = new Set<string>();
      await context.reply(`开始重建原神和星铁面板，现有面板会保留到新数据写入成功。更新间隔 ${intervalMs / 1000} 秒。`);
      let wait = false;
      for (const { qq, profileId, game, role } of targets) {
        verifyAuthority();
        const label = `QQ ${qq} · P${profileId} · ${gameNames[game]} · UID ${role.uid}`;
        function report(outcome: keyof typeof status, detail: string) {
          status[outcome]++;
          if (rows.length < reportRows) rows.push(`${label}：${detail}`);
        }
        // Current panel archives are per QQ and UID. A successful duplicate profile need not write the same archive again.
        const key = `${game}:${qq}:${role.uid}`;
        const update = providers.get(game);
        if (!update || finished.has(key)) {
          report("skipped", update ? "同一面板已更新" : "模块已卸载");
          continue;
        }
        if (wait && intervalMs) await setTimeout(intervalMs, undefined, { signal: active });
        verifyAuthority();
        if (update !== providers.get(game)) {
          report("skipped", "模块已重新加载");
          continue;
        }
        wait = true;
        try {
          if (await update(qq, profileId, role.uid, active, verifyAuthority)) {
            finished.add(key);
            report("done", "更新成功");
          } else report("skipped", "已有更新或存档已变更");
        } catch (error) {
          verifyAuthority();
          if (error instanceof ProfileError && (error.code === "missing" || error.code === "role-missing" ||
              error.code === "login-required" || error.code === "changed")) report("skipped", "登录或绑定状态已变更");
          else report("failed", "更新未完成");
        }
      }
      verifyAuthority();
      const title = "原神和星铁面板重建";
      const lead = `更新 ${status.done} 项，跳过 ${status.skipped} 项，失败 ${status.failed} 项。`;
      if (targets.length > reportRows) rows.push(`还有 ${targets.length - reportRows} 项已计入总数。`);
      const card = await render(title, lead, rows, new Date()).catch(() => undefined);
      verifyAuthority();
      return card ? segment.image(card.png) : [title, lead, ...rows].join("\n");
    } catch {
      if (!active.aborted) return "面板重建提前结束，请查看档案状态后重试。";
    } finally {
      rebuilding = false;
    }
  };

  return { register, fallback };
}
