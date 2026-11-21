import type { BotNotifications } from "./checkin-notify.ts";

export async function resolvePrivateFriendRoute(online: () => readonly BotNotifications[], userId: number,
  boundBot: number | undefined, active: () => boolean, knownBots: () => readonly number[] = () => []) {
  if (!Number.isSafeInteger(userId) || userId < 1 || !active()) return;
  const eligible = () => online().filter(({ botId }) => botId !== userId && (boundBot === undefined || botId === boundBot));
  const candidates = eligible();
  const ids = new Set(candidates.map(candidate => candidate.botId));
  const uniqueCandidates = () => {
    const current = eligible();
    return current.length === ids.size && current.every(candidate => ids.has(candidate.botId)) &&
      (boundBot !== undefined || knownBots().every(botId => botId === userId || ids.has(botId)));
  };
  if (!uniqueCandidates()) return;
  const verdicts = await Promise.all(candidates.map(candidate => candidate.friendship?.(userId).catch(() => undefined)));
  if (!active() || !uniqueCandidates() || verdicts.some(verdict => verdict === undefined)) return;

  // A role without a recorded bot may use the original routing only when one live friend is proven.
  const friends = candidates.filter((_, index) => verdicts[index] === true);
  const target = friends.length === 1 ? friends[0] : undefined;
  if (!target) return;
  return {
    botId: target.botId,
    async send(text: string) {
      if (!active() || !uniqueCandidates()) return "rejected" as const;
      return target.sendPrivate(userId, text);
    },
  };
}
