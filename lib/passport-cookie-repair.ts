import type { createProfileStore } from "@lotus-yunzai/account";
import { needsLegacyCookieRepair, type createProfileHoyoClient } from "@lotus-yunzai/hoyo-client";

type Profiles = Pick<ReturnType<typeof createProfileStore>, "listCheckinProfiles" | "accountContext">;
type Client = Pick<ReturnType<typeof createProfileHoyoClient>, "refreshCredentials">;

export async function repairLegacyPassportCookies(profiles: Profiles, client: Client, signal: AbortSignal) {
  let repaired = 0, failed = 0;
  if (signal.aborted) return { repaired, failed };
  for (const { qq, profileId, loggedIn } of await profiles.listCheckinProfiles()) {
    if (signal.aborted) break;
    if (!loggedIn) continue;
    try {
      const source = await profiles.accountContext(qq, profileId);
      if (signal.aborted) break;
      if (!needsLegacyCookieRepair(source.account)) continue;
      await client.refreshCredentials(source);
      repaired++;
    } catch { failed++; }
  }
  return { repaired, failed };
}

export function scheduleLegacyPassportCookieRepair(signal: AbortSignal, sweep: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay: number) => {
    if (signal.aborted) return;
    timer = setTimeout(() => {
      if (!signal.aborted) void sweep().catch(() => undefined).finally(() => schedule(6 * 60 * 60_000));
    }, delay).unref();
  };
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  schedule(30_000);
}
