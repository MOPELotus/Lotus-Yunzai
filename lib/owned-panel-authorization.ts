import type { createProfileStore, Game } from "@lotus-yunzai/account";

type Profiles = Pick<ReturnType<typeof createProfileStore>, "requestContext">;
type Scope = { readonly user: number; readonly signal: AbortSignal; readonly isCurrent: () => boolean };

/** Explicit UID exports require a role belonging to the requested login profile. */
export async function ownedPanelAuthorization(profiles: Profiles, game: Game, uid: string, profileId: number, scope: Scope) {
  const active = () => !scope.signal.aborted && scope.isCurrent();
  if (!active()) return;
  const qq = String(scope.user);
  const source = await profiles.requestContext(qq, profileId, game, uid).catch(() => undefined);
  if (!source || source.role.uid !== uid || !active()) return;
  return async () => {
    if (!active()) return false;
    const current = await profiles.requestContext(qq, profileId, game, uid).catch(() => undefined);
    return active() && current?.revision === source.revision && current.role.uid === uid &&
      current.role.region === source.role.region && current.role.gameBiz === source.role.gameBiz;
  };
}
