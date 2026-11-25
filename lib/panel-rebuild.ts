import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
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
const gameNames = { gs: $t("lib.panel-rebuild.text_d1597c51ed"), sr: $t("lib.panel-rebuild.text_a2927891f0") };
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
        !context.isBotMaster(context.user_id)) return $t("lib.panel-rebuild.text_98fa82bf71");
    const active = AbortSignal.any([signal, context.privateCredentialSignal]);
    const requester = context.user_id;
    function verifyAuthority() {
      active.throwIfAborted();
      if (!context.isBotMaster(requester)) throw new Error($t("lib.panel-rebuild.text_d7f6d09f39"));
    }
    if (active.aborted) return;
    if (rebuilding) return $t("lib.panel-rebuild.text_cd0cdd55e8");
    rebuilding = true;
    try {
      if (!providers.size) return $t("lib.panel-rebuild.text_251d756629");
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
      if (!targets.length) return $t("lib.panel-rebuild.text_18e8855081");
      const status = { done: 0, skipped: 0, failed: 0 };
      const rows: string[] = [];
      const finished = new Set<string>();
      await context.reply($t("lib.panel-rebuild.text_0ab8bb63c3", { "value1": intervalMs / 1000 }));
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
          report("skipped", update ? $t("lib.panel-rebuild.text_eedbc70107") : $t("lib.panel-rebuild.text_30c81d2ad5"));
          continue;
        }
        if (wait && intervalMs) await setTimeout(intervalMs, undefined, { signal: active });
        verifyAuthority();
        if (update !== providers.get(game)) {
          report("skipped", $t("lib.panel-rebuild.text_a406a2a867"));
          continue;
        }
        wait = true;
        try {
          if (await update(qq, profileId, role.uid, active, verifyAuthority)) {
            finished.add(key);
            report("done", $t("lib.panel-rebuild.text_7c0d266486"));
          } else report("skipped", $t("lib.panel-rebuild.text_7f9f355345"));
        } catch (error) {
          verifyAuthority();
          if (error instanceof ProfileError && (error.code === "missing" || error.code === "role-missing" ||
              error.code === "login-required" || error.code === "changed")) report("skipped", $t("lib.panel-rebuild.text_65aefded62"));
          else report("failed", $t("lib.panel-rebuild.text_607e00bd9a"));
        }
      }
      verifyAuthority();
      const title = $t("lib.panel-rebuild.text_f01182d86e");
      const lead = $t("lib.panel-rebuild.text_fc1b3ca42e", { "done": status.done, "skipped": status.skipped, "failed": status.failed });
      if (targets.length > reportRows) rows.push($t("lib.panel-rebuild.text_04859d136e", { "value1": targets.length - reportRows }));
      const card = await render(title, lead, rows, new Date()).catch(() => undefined);
      verifyAuthority();
      return card ? segment.image(card.png) : [title, lead, ...rows].join("\n");
    } catch {
      if (!active.aborted) return $t("lib.panel-rebuild.text_b8af43f382");
    } finally {
      rebuilding = false;
    }
  };

  return { register, fallback };
}
