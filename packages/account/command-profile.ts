import { AsyncLocalStorage } from "node:async_hooks";
import type { Game } from "./index.ts";

export type GameCommandProfiles = Readonly<Partial<Record<Game, number>>>;

type CommandProfileScope = {
  readonly user: number;
  readonly profiles: GameCommandProfiles;
  readonly isCurrent: () => boolean;
};

const commandProfiles = new AsyncLocalStorage<CommandProfileScope | undefined>();

export function withGameCommandProfiles<Result>(scope: CommandProfileScope | undefined, run: () => Result): Result {
  return commandProfiles.run(scope, run);
}

export function forGameCommandSender<Result>(user: number | undefined, delegated: boolean | undefined, run: () => Result): Result {
  const scope = commandProfiles.getStore();
  return scope && (scope.user !== user || delegated) ? commandProfiles.run(undefined, run) : run();
}

/** 将未填档号的聊天指令路由到本人的游戏默认档。已解析出的明确档号及非聊天调用照旧。 */
export function gameCommandProfileId(game: Game, explicit?: string | number): number {
  if (explicit !== undefined) return Number(explicit);
  const scope = commandProfiles.getStore();
  return scope?.isCurrent() ? scope.profiles[game] ?? 1 : 1;
}
