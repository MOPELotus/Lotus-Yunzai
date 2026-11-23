import type { Game } from "@lotus-yunzai/account";

type Session = {
  readonly adapter: "onebot" | "milky"; readonly bot: number; readonly user: number;
  readonly connection: AbortSignal; readonly isCurrent: () => boolean;
};
type Prompt = { readonly game: Game; readonly connection: AbortSignal; readonly expires: number; delivered: boolean };
const lifetime = 120_000;
const maximum = 512;
const key = ({ adapter, bot, user }: Session) => `${adapter}:${bot}:${user}`;

export function matchPublicRoleRegistrationFollowup(text: string) {
  const input = text.trim();
  return /^(?:[1-9]\d{7,9}|#?取消登记)$/u.test(input) ? input : undefined;
}

export function createPublicRoleRegistration(now = Date.now) {
  const pending = new Map<string, Prompt>();
  return {
    async start(scope: Session, game: Game, sendPrompt: () => boolean | Promise<boolean>) {
      if (scope.connection.aborted || !scope.isCurrent()) return;
      for (const [id, prompt] of pending) if (prompt.connection.aborted || prompt.expires <= now()) pending.delete(id);
      const id = key(scope);
      if (!pending.has(id) && pending.size >= maximum) pending.delete(pending.keys().next().value!);
      const prompt: Prompt = { game, connection: scope.connection, expires: now() + lifetime, delivered: false };
      pending.set(id, prompt);
      const delivered = await Promise.resolve().then(sendPrompt).catch(() => false);
      if (pending.get(id) !== prompt) return;
      if (!delivered || !scope.isCurrent() || scope.connection.aborted) pending.delete(id);
      else prompt.delivered = true;
    },
    consume(scope: Session, input: string) {
      const id = key(scope);
      const prompt = pending.get(id);
      if (!prompt || !scope.isCurrent()) return;
      if (prompt.connection !== scope.connection || scope.connection.aborted || now() >= prompt.expires) {
        pending.delete(id);
        return;
      }
      if (!prompt.delivered) return;
      pending.delete(id);
      return input.endsWith("取消登记") ? { cancelled: true as const }
        : { game: prompt.game, action: "登记公开uid", value: input };
    },
    clear(scope: Session) { pending.delete(key(scope)); },
  };
}
