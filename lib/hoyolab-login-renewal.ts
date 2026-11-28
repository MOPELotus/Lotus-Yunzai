import type { createProfileStore } from "@lotus-yunzai/account";
import { createHoYoLabLogin, HoYoLabLoginError } from "../packages/hoyo-client/hoyolab-login.ts";
import type { HoyoTransport } from "../packages/hoyo-client/credentials.ts";
import { createTranslator } from "../packages/i18n/index.ts";
import catalog from "../i18n/zh-CN.json";
const $t = createTranslator("core", catalog.messages);
const refreshMs = 2 * 60 * 60_000;
export function createHoYoLabCredentialRenewal(profiles: ReturnType<typeof createProfileStore>, transport: HoyoTransport,
  signal: AbortSignal, { now = Date.now, withIdleSlot, warn = () => console.warn($t("lib.hoyolab-login-web.renewFailed")) }:
  { readonly now?: () => number; readonly warn?: () => void; readonly withIdleSlot?: (run: () => Promise<void>) => Promise<unknown> } = {}) {
  const client = createHoYoLabLogin(transport);
  let running: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined;
  async function sweep() {
    for (const { qq, profileId } of await profiles.listCheckinProfiles()) {
      if (signal.aborted) return;
      const saved = await profiles.internationalCredentials(qq, profileId).catch(() => undefined);
      if (!saved) continue;
      const refreshed = Date.parse(saved.refreshedAt);
      if (Number.isFinite(refreshed) && now() - refreshed < refreshMs) continue;
      const refresh = async () => {
        signal.throwIfAborted();
        let result: Awaited<ReturnType<typeof client.exchange>> | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { result = await client.exchange(saved, signal); break; }
          catch (error) { if (signal.aborted || !(error instanceof HoYoLabLoginError) || error.kind !== "network" || attempt === 2) throw error; }
        }
        if (result) await profiles.saveInternationalRefreshed(qq, profileId, saved.revision, result, signal);
      };
      try { if (withIdleSlot) await withIdleSlot(refresh); else await refresh(); }
      catch { if (!signal.aborted) warn(); }
    }
  }
  function run() {
    if (signal.aborted) return Promise.resolve();
    return running ??= sweep().finally(() => { running = undefined; });
  }
  function close() { if (timer) clearInterval(timer); timer = undefined; }
  signal.addEventListener("abort", close, { once: true });
  return { run, close,
    start() {
      if (timer || signal.aborted) return;
      // This worker never creates manual captcha sessions or replays a password login.
      timer = setInterval(() => { void run().catch(() => { if (!signal.aborted) warn(); }); }, 15 * 60_000);
      timer.unref(); void run().catch(() => { if (!signal.aborted) warn(); });
    },
  };
}
