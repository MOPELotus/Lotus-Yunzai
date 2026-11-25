import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
import { MAX_PROFILE_ID, ProfileError, type createProfileStore, type Game } from "@lotus-yunzai/account";
import type { createGameProfileDefaults } from "./game-profile-defaults.ts";

const $t = createTextTranslator("core", messageCatalog.messages);
const games = ["gs", "sr", "zzz"] as const;
const labels = { gs: "lib.own-role-selection.text_d1597c51ed", sr: "lib.own-role-selection.text_a2927891f0", zzz: "lib.own-role-selection.text_b1110352c9" } as const;
const prefixes = { gs: "#", sr: "*", zzz: "%" } as const;
const gameCodes = { 原神: "gs", 星铁: "sr", 绝区零: "zzz" } as const;
const entry = /^(?:#(原神|星铁|绝区零)?|([*＊%％]))(当前档案|档案列表|切换档案)(.*)$/u;

type Command = { readonly kind: "current" | "list"; readonly game?: Game }
  | { readonly kind: "switch"; readonly game: Game; readonly profileId: number }
  | { readonly kind: "invalid"; readonly game: Game };
type Scope = { readonly user: number; readonly signal: AbortSignal; readonly isCurrent: () => boolean; readonly isDelegated?: boolean };
type Profiles = Pick<ReturnType<typeof createProfileStore>, "listIds" | "describe" | "requestSelectedContext">;
type Defaults = Pick<ReturnType<typeof createGameProfileDefaults>, "read" | "select">;

export function matchGameProfileCommand(message: string): Command | undefined {
  const match = entry.exec(message.trim());
  if (!match) return;
  const game = match[1] ? gameCodes[match[1] as keyof typeof gameCodes]
    : match[2] ? /[*＊]/u.test(match[2]) ? "sr" : "zzz" : undefined;
  const value = match[4]!.trim();
  if (match[3] !== "切换档案") return value ? { kind: "invalid", game: game ?? "gs" }
    : { kind: match[3] === "当前档案" ? "current" : "list", game };
  const profileId = Number(value);
  if (!/^[1-9]\d{0,2}$/u.test(value) || profileId > MAX_PROFILE_ID) return { kind: "invalid", game: game ?? "gs" };
  return { kind: "switch", game: game ?? "gs", profileId };
}

/** Only explicit switching writes the per-game profile preference; listing is read-only. */
export function createGameProfileCommands(profiles: Profiles, defaults: Defaults) {
  return async (command: Command, scope: Scope): Promise<string | undefined> => {
    const active = () => !scope.isDelegated && Number.isSafeInteger(scope.user) && scope.user > 0 &&
      !scope.signal.aborted && scope.isCurrent();
    if (!active()) return;
    const selectedGames = command.game ? [command.game] : games;
    if (command.kind === "invalid") return $t("lib.game-profile-commands.invalid", { max: MAX_PROFILE_ID, prefix: prefixes[command.game] });
    const qq = String(scope.user);
    try {
      if (command.kind === "switch") {
        const { game, profileId: id } = command;
        const profile = await profiles.describe(qq, id);
        if (!active()) return;
        if (!profile.loggedIn) return $t("lib.game-profile-commands.login", { id });
        const source = await profiles.requestSelectedContext(qq, id, game);
        if (!active()) return;
        const saved = await defaults.select(game, id, source.role.uid, source.revision, scope);
        if (!active()) return;
        return saved ? $t("lib.game-profile-commands.selected", { game: $t(labels[game]), id }) : $t("lib.game-profile-commands.changed");
      }
      const current = await defaults.read(qq);
      if (!active()) return;
      const currentRows = await Promise.all(selectedGames.map(async game => {
        const id = current[game] ?? 1;
        const profile = await profiles.describe(qq, id).catch(() => undefined);
        return $t("lib.game-profile-commands.current-row", { game: $t(labels[game]), id,
          state: profile?.loggedIn ? "" : $t("lib.game-profile-commands.unlogged") });
      }));
      if (!active()) return;
      const lines = [$t("lib.game-profile-commands.current-title"), ...currentRows];
      if (command.kind === "current") return lines.join("\n");
      const ids = await profiles.listIds(qq);
      if (!active()) return;
      const loggedIn = [];
      for (const id of ids) {
        const profile = await profiles.describe(qq, id).catch(() => undefined);
        if (!active()) return;
        if (!profile?.loggedIn) continue;
        const available = selectedGames.filter(game => profile.roles[game].length).map(game => $t(labels[game]));
        loggedIn.push($t("lib.game-profile-commands.list-row", { id, games: available.join("、") || $t("lib.game-profile-commands.no-role") }));
      }
      return [...lines, "", $t("lib.game-profile-commands.list-title"), ...(loggedIn.length ? loggedIn : [$t("lib.game-profile-commands.no-profiles")]),
        "", $t("lib.game-profile-commands.list-help")].join("\n");
    } catch (error) {
      if (!active()) return;
      if (command.kind === "switch" && error instanceof ProfileError) {
        if (error.code === "missing" || error.code === "login-required") return $t("lib.game-profile-commands.login", { id: command.profileId });
        if (error.code === "role-missing") return $t("lib.game-profile-commands.role-missing", { id: command.profileId, game: $t(labels[command.game]) });
        if (error.code === "changed") return $t("lib.game-profile-commands.changed");
      }
      if (error instanceof DOMException && error.name === "AbortError") return $t("lib.game-profile-commands.changed");
      return $t("lib.game-profile-commands.failed");
    }
  };
}
