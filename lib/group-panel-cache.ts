import { isCaptchaResourceBusy } from "@lotus-yunzai/hoyo-client";
import type { PanelCacheSummary } from "./runtime-trace.ts";
import type { createProfileStore, Game } from "@lotus-yunzai/account";
import { createRoleJsonArchive, type AcquireRoleArchiveLock } from "@lotus-yunzai/storage";
import type { GroupPanelAccount, OfficialGroupPanels } from "./group-panel-accounts.ts";

export interface PanelCacheRuntime {
  readonly disconnect: AbortSignal;
  register(game: "gs" | "sr", run: () => Promise<PanelCacheSummary | void>): () => Promise<void>;
}

export function cachedGroupPanels<S, C>(profiles: ReturnType<typeof createProfileStore>, game: Game,
  source: OfficialGroupPanels<S, C>, read: (entry: GroupPanelAccount, context: C) => Promise<S>): OfficialGroupPanels<S, C> {
  return { list: source.list, async read(entry, signal, authority, context) {
    const verify = async () => {
      signal.throwIfAborted();
      await authority();
      const role = await profiles.savedRole(String(entry.qq), entry.profileId, game);
      if (role.uid !== entry.role.uid || role.region !== entry.role.region || role.gameBiz !== entry.role.gameBiz)
        throw new Error("group-panel-role-changed");
    };
    await verify();
    const snapshot = await read(entry, context);
    await verify();
    return snapshot;
  } };
}

export function createGroupPanelCacheRefresh<S, C>(profiles: ReturnType<typeof createProfileStore>,
  source: OfficialGroupPanels<S, C>, lock: AcquireRoleArchiveLock, signal: AbortSignal,
  directory: string, context: () => Promise<C>, now = Date.now) {
  const state = createRoleJsonArchive(directory, lock, { subject: "panel-refresh", lockSuffix: "panel-refresh", maxBytes: 4096 });
  let running: Promise<PanelCacheSummary> | undefined;
  return () => {
    if (running) return running;
    running = (async () => {
      const counts: PanelCacheSummary = { refreshed: 0, failed: 0, busy: 0, skipped: 0 };
      signal.throwIfAborted();
      const slots = (await profiles.listCheckinProfiles()).filter(row => row.loggedIn);
      const loggedIn = new Set(slots.map(row => `${row.qq}:${row.profileId}`));
      const entries = (await source.list(new Set(slots.map(row => Number(row.qq))), signal))
        .filter(row => loggedIn.has(`${row.qq}:${row.profileId}`));
      const data = await context();
      let next = 0;
      const worker = async () => {
        while (next < entries.length && !signal.aborted) {
          const entry = entries[next++]!;
          const identity = { qq: String(entry.qq), uid: entry.role.uid };
          const before = await state.read(identity.qq, identity.uid) as { refreshedAt?: number; attemptedAt?: number } | null;
          let refreshedAt = Number(before?.refreshedAt) || 0;
          const attemptedAt = Number(before?.attemptedAt) || 0;
          if ((refreshedAt && now() - refreshedAt < 3_600_000) || (attemptedAt && now() - attemptedAt < 900_000)) { counts.skipped++; continue; }
          try {
            await source.read(entry, signal, async () => { signal.throwIfAborted(); }, data);
            refreshedAt = now();
            counts.refreshed++;
          } catch (error) {
            if (signal.aborted) break;
            if (isCaptchaResourceBusy(error)) { counts.busy++; continue; }
            counts.failed++;
          }
          await state.update(identity, async () => { signal.throwIfAborted(); }, () => ({
            document: { refreshedAt, attemptedAt: now() }, result: undefined,
          }));
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, entries.length) }, worker));
      signal.throwIfAborted();
      return counts;
    })().finally(() => { running = undefined; });
    return running;
  };
}
