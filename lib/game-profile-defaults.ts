import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createHash } from "node:crypto";
import { MAX_PROFILE_ID, profileCookieAccountId, type createProfileStore, type Game, type GameCommandProfiles } from "@lotus-yunzai/account";
import { createRoleJsonArchive, type AcquireRoleArchiveLock } from "@lotus-yunzai/storage";

export const gameProfileDefaultsPath = "data/account/game-defaults";
const games = ["gs", "sr", "zzz"] as const;

export function gameProfileAccountFingerprint(qq: string, game: Game, accountId: string) {
  return createHash("sha256").update(`lotus-default-profile:\0${qq}\0${game}\0${accountId}`).digest("hex");
}
type Profiles = Pick<ReturnType<typeof createProfileStore>, "requestSelectedContext">;
type Scope = { readonly user: number; readonly signal: AbortSignal; readonly isCurrent: () => boolean };
type Default = { readonly profileId: number; readonly account: string };
type Defaults = Partial<Record<Game, Default>>;

function decode(value: unknown): Defaults {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1) return {};
  const current = value as Partial<Record<Game, Partial<Default>>>;
  const defaults: Defaults = {};
  for (const game of games) {
    const entry = current[game];
    const id = entry?.profileId;
    if (entry && typeof id === "number" && Number.isSafeInteger(id) && id >= 1 && id <= MAX_PROFILE_ID &&
        typeof entry.account === "string" && /^[a-f0-9]{64}$/u.test(entry.account)) defaults[game] = { profileId: id, account: entry.account };
  }
  return defaults;
}

export function createGameProfileDefaults(directory: string, profiles: Profiles, lockFile: AcquireRoleArchiveLock) {
  const saved = createRoleJsonArchive(directory, lockFile, {
    subject: $t("lib.game-profile-defaults.text_5dae846e28"), lockSuffix: "game-profile-defaults", maxBytes: 2048, rejectNull: true,
  });
  async function readBinding(qq: string, id: number, game: Game) {
    const source = await profiles.requestSelectedContext(qq, id, game).catch(() => undefined);
    const idValue = source?.international ? `os:${source.international.realm}:${source.international.accountId}` : source && profileCookieAccountId(source.account);
    if (source && idValue && source.role.uid) {
      const account = gameProfileAccountFingerprint(qq, game, idValue);
      return { account, revision: source.revision, uid: source.role.uid };
    }
  }

  return {
    async read(qq: string): Promise<GameCommandProfiles> {
      const defaults = decode(await saved.read(qq, "1").catch(() => undefined));
      const active: Partial<Record<Game, number>> = {};
      await Promise.all(games.map(async game => {
        const entry = defaults[game];
        if (entry && (await readBinding(qq, entry.profileId, game))?.account === entry.account) active[game] = entry.profileId;
      }));
      return active;
    },
    async select(game: Game, profileId: number, uid: string, revision: string, scope: Scope) {
      const active = () => !scope.signal.aborted && scope.isCurrent();
      const qq = String(scope.user);
      if (!active()) return false;
      const current = await readBinding(qq, profileId, game);
      if (!current || current.revision !== revision || current.uid !== uid || !active()) return false;
      const verify = async () => {
        const latest = active() && await readBinding(qq, profileId, game);
        if (!latest || latest.revision !== revision || latest.uid !== uid || latest.account !== current.account || !active()) {
          throw new DOMException($t("lib.game-profile-defaults.text_3ad8080e35"), "AbortError");
        }
      };
      return saved.update({ qq, uid: "1" }, verify, snapshot => {
        const defaults = decode(snapshot);
        const previous = defaults[game];
        if (previous?.profileId === profileId && previous.account === current.account) return { result: true };
        if (profileId === 1) {
          if (!previous) return { result: true };
          delete defaults[game];
        } else {
          defaults[game] = { profileId, account: current.account };
        }
        return { document: { version: 1, ...defaults }, result: true };
      });
    },
  };
}
