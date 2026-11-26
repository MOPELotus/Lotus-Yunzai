import type { createProfileStore, Game, GameRole, ProfileRequestContext } from "@lotus-yunzai/account";

type Profiles = Pick<ReturnType<typeof createProfileStore>, "listCheckinProfiles" | "savedRole" | "requestContext">;
export interface GroupPanelAccount {
  readonly qq: number;
  readonly profileId: number;
  readonly role: Pick<GameRole, "uid" | "region" | "gameBiz">;
  readonly observedAt: number;
}
export interface OfficialGroupPanels<Snapshot, Context = undefined> {
  list(members: ReadonlySet<number>, signal: AbortSignal): Promise<GroupPanelAccount[]>;
  read(entry: GroupPanelAccount, signal: AbortSignal, verifyAuthority: () => Promise<void>, context: Context): Promise<Snapshot>;
}
export function createOfficialGroupPanels<Result extends { readonly revision: string }, Snapshot, Context = undefined>(
  profiles: Profiles, game: Game,
  fetchPanel: (source: ProfileRequestContext, signal: AbortSignal) => Promise<Result>,
  save: (result: Result, owner: GroupPanelAccount, verify: () => Promise<void>, context: Context, startedAt: number) => Promise<Snapshot>,
): OfficialGroupPanels<Snapshot, Context> {
  const sameRole = (a: GroupPanelAccount["role"], b: GroupPanelAccount["role"]) =>
    a.uid === b.uid && a.region === b.region && a.gameBiz === b.gameBiz;
  return {
    async list(members, signal) {
      const slots = await profiles.listCheckinProfiles(new Set([...members].map(String)));
      const result: GroupPanelAccount[] = [];
      const seen = new Set<string>();
      for (const { qq, profileId } of slots.sort((a, b) => Number(b.loggedIn) - Number(a.loggedIn))) {
        signal.throwIfAborted();
        if (!members.has(Number(qq))) continue;
        const role = await profiles.savedRole(qq, profileId, game).catch(() => undefined);
        if (role) {
          const key = `${role.gameBiz}:${role.region}:${role.uid}`;
          if (seen.has(key)) continue;
          seen.add(key);
          result.push({ qq: Number(qq), profileId, role, observedAt: Date.now() });
        }
      }
      return result;
    },
    async read(entry, signal, verifyAuthority, context) {
      const qq = String(entry.qq);
      signal.throwIfAborted();
      await verifyAuthority();
      const source = await profiles.requestContext(qq, entry.profileId, game);
      if (!sameRole(source.role, entry.role)) throw new Error("group-panel-role-changed");
      const startedAt = Date.now();
      const result = await fetchPanel(source, signal);
      const verify = async () => {
        signal.throwIfAborted();
        await verifyAuthority();
        const current = await profiles.requestContext(qq, entry.profileId, game);
        if (current.revision !== result.revision || !sameRole(current.role, entry.role)) throw new Error("group-panel-account-changed");
      };
      await verify();
      const snapshot = await save(result, entry, verify, context, startedAt);
      await verify();
      return snapshot;
    },
  };
}
