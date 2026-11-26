import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { createProfileStore } from "@lotus-yunzai/account";
import type { createProfileHoyoClient } from "@lotus-yunzai/hoyo-client";
import { lockFile } from "../lib/file-lock.ts";
import { createGroupPanelCacheRefresh } from "../lib/group-panel-cache.ts";
import { createGenshinOfficialGroupPanels, createGenshinCachedGroupPanels } from "../plugins/genshin/panel/group-rank-official.ts";
import { createStarRailOfficialGroupPanels, createStarRailCachedGroupPanels } from "../plugins/starrail/group-rank-official.ts";
import { readPanelTheme } from "../plugins/genshin/panel/theme.ts";

test("GS/SR hourly refresh persists checkpoints; ranking reads owned cache without network", async () => {
 const root = await mkdtemp(join(tmpdir(), "lotus-game-cache-"));
 const signal = new AbortController().signal;
 try {
  for (const game of ["gs", "sr"] as const) {
   let clock = 1_000_000, calls = 0, requests = 0, loggedIn = true, fail = false, changed = false;
   const role = () => ({ uid: changed ? "100000043" : "100000042", region: "cn_gf01", gameBiz: game === "gs" ? "hk4e_cn" : "hkrpg_cn" });
   const profiles = {
    async listCheckinProfiles() { return [{ qq: "42", profileId: 1, loggedIn }, { qq: "42", profileId: 2, loggedIn }]; },
    async savedRole() { return role(); },
    async requestContext() { requests++; return { role: role(), revision: "first" }; },
   } as unknown as ReturnType<typeof createProfileStore>;
   const fetchPanel = async () => { calls++; await Bun.sleep(1); if (fail) throw Error("offline"); return { revision: "first", avatars: [] }; };
   const client = { fetchGenshinPanel: fetchPanel, fetchStarRailPanel: fetchPanel } as unknown as ReturnType<typeof createProfileHoyoClient>;
   const theme = await readPanelTheme();
   const dir = join(root, game);
   // Both game factories have different context types; exercise their real archives independently.
   async function exercise<C, S>(source: import("../lib/group-panel-accounts.ts").OfficialGroupPanels<S, C>,
     cached: import("../lib/group-panel-accounts.ts").OfficialGroupPanels<S, C>, context: C) {
    const create = () => createGroupPanelCacheRefresh(profiles, source, lockFile, signal, join(dir, "state"), async () => context, () => clock);
    const refresh = create();
    const first = refresh(); expect(refresh()).toBe(first); await first;
    expect(calls).toBe(1);
    await refresh(); expect(calls).toBe(1);
    clock += 3_600_000; fail = true; await refresh(); expect(calls).toBe(2);
    await create()(); expect(calls).toBe(2);
    const entries = await cached.list(new Set([42]), signal); expect(entries.length).toBe(1);
    loggedIn = false;
    const before = { calls, requests };
    const snapshot = await cached.read(entries[0]!, signal, async () => {}, context);
    expect(snapshot).toBeDefined(); expect({ calls, requests }).toEqual(before);
    await expect(cached.read(entries[0]!, signal, async () => { throw Error("membership-changed"); }, context)).rejects.toThrow("membership-changed");
    await expect(cached.read(entries[0]!, signal, async () => { changed = true; }, context)).rejects.toThrow("role-changed");
   }
   if (game === "gs") await exercise(createGenshinOfficialGroupPanels(profiles, client, lockFile, dir), createGenshinCachedGroupPanels(profiles, client, lockFile, dir), theme);
   else await exercise(createStarRailOfficialGroupPanels(profiles, client, lockFile, dir), createStarRailCachedGroupPanels(profiles, client, lockFile, dir), undefined);
  }
 } finally { await rm(root, { recursive: true, force: true }); }
});
