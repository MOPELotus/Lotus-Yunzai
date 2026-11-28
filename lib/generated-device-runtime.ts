import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { setTimeout as wait } from "node:timers/promises";
import { createProfileStore, parseAndroidDeviceInfo, ProfileError } from "@lotus-yunzai/account";
import { requestDeviceFingerprint, type HoyoTransport } from "@lotus-yunzai/hoyo-client";

// Mirrors Lotus-Plugin core/devices/{generated-profile,runtime}.js.
export function createGeneratedDeviceRefresh(profiles: ReturnType<typeof createProfileStore>, {
  transport, signal, now = Date.now, report = (message: string) => console.warn(message),
}: { readonly transport?: HoyoTransport; readonly signal: AbortSignal; readonly now?: () => number;
  readonly report?: (message: string) => void }) {
  const inflight = new Map<string, Promise<{ ok: boolean; changed?: boolean; cooldown?: boolean; skipped?: boolean }>>();
  const retries = new Map<string, { failures: number; nextAt: number }>();
  let started = false;
  async function prepare() {
    let generated = 0, failed = 0;
    for (const target of await profiles.listCheckinProfiles()) {
      signal.throwIfAborted();
      if (!target.loggedIn) continue;
      try {
        const previous = await profiles.accountContext(target.qq, target.profileId);
        const plan = await profiles.prepareGeneratedDevice(target.qq, target.profileId, signal);
        if (previous.revision !== plan.source.revision) generated++;
      } catch (error) { signal.throwIfAborted(); if (!(error instanceof ProfileError && error.code === "login-required")) failed++; }
    }
    return { generated, failed };
  }
  async function issue(qq: string, profileId: number) {
    signal.throwIfAborted();
    const plan = await profiles.prepareGeneratedDevice(qq, profileId, signal);
    if (!plan.pending) return { ok: true, skipped: true };
    const { source, instanceId, deviceGuid } = plan;
    const key = `${qq}:${profileId}:${instanceId}`;
    const previous = retries.get(key);
    if (previous && previous.nextAt > now()) return { ok: false, cooldown: true };
    const verify = () => profiles.verifyDeviceBindingTarget(qq, profileId, source);
    try {
      const info = parseAndroidDeviceInfo(JSON.stringify(source.device.raw));
      if (!info || !instanceId) throw new TypeError($t("lib.generated-device-runtime.text_26d1c56803"));
      const binding = await requestDeviceFingerprint(info, { transport, signal, verify,
        identity: { deviceId: source.device.id, deviceGuid } });
      await verify();
      await profiles.saveGeneratedDeviceFp(source, instanceId, binding.fp, signal);
      retries.delete(key);
      return { ok: true };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ProfileError && error.code === "changed") return { ok: false, changed: true };
      const failures = Math.min((previous?.failures ?? 0) + 1, 10);
      retries.set(key, { failures, nextAt: now() + Math.min(6 * 3_600_000, 60_000 * 2 ** (failures - 1)) });
      if (retries.size > 2048) retries.delete(retries.keys().next().value!);
      report($t("lib.generated-device-runtime.text_890aa3293f"));
      return { ok: false };
    }
  }
  function refresh(qq: string, profileId = 1) {
    const key = `${qq}:${profileId}`;
    const pending = inflight.get(key);
    if (pending) return pending;
    const operation = issue(qq, profileId);
    inflight.set(key, operation);
    void operation.finally(() => { if (inflight.get(key) === operation) inflight.delete(key); }).catch(() => undefined);
    return operation;
  }
  async function sweep() {
    for (const target of await profiles.listCheckinProfiles()) {
      signal.throwIfAborted();
      if (!target.loggedIn) continue;
      let skipped = false;
      try { skipped = Boolean((await refresh(target.qq, target.profileId)).skipped); }
      catch (error) { signal.throwIfAborted();
        if (error instanceof ProfileError && error.code === "login-required") skipped = true;
        else report($t("lib.generated-device-runtime.text_49e805b40f"));
      }
      if (!skipped) await wait(1000, undefined, { signal });
    }
  }
  function start() {
    if (started || signal.aborted) return;
    started = true;
    let timer: ReturnType<typeof setTimeout>;
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    const schedule = (delay: number) => {
      timer = setTimeout(async () => {
        try { await sweep(); }
        catch { if (!signal.aborted) report($t("lib.generated-device-runtime.text_49e805b40f")); }
        if (!signal.aborted) schedule(60_000);
      }, delay);
      timer.unref();
    };
    schedule(0);
  }
  return { prepare, refresh, start };
}
