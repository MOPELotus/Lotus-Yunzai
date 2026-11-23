import type { DeliveryCommandReply } from "./commands.ts";
import { readLocalConfig } from "./config.ts";
import { readLegacyPanelRecovery } from "./legacy-panel-recovery.ts";

type Game = "gs" | "sr";
type Scope = { readonly adapter: "onebot" | "milky"; readonly bot: number; readonly user: number;
  readonly signal: AbortSignal; readonly isCurrent: () => boolean };
type Target = { readonly game: Game; readonly profileId: number; readonly uid: string };
type Authorize = (target: Target, scope: Scope) => Promise<(() => Promise<boolean>) | undefined>;
type Pending = { readonly candidate: Candidate; readonly authority: () => Promise<boolean>; readonly origin: Scope };
type Receipt = { readonly sequence: bigint; readonly expires: number; readonly offer?: Pending };
type Candidate = Target & {
  isEmpty(): Promise<boolean>;
  save(playerData: Readonly<Record<string, unknown>>, verify: () => Promise<void>): Promise<number | undefined>;
};
export type LegacyPanelRecoveryOffer = (candidate: Candidate) => Promise<DeliveryCommandReply | undefined>;

const lifetime = 5 * 60_000;
const maxPending = 4096;
const uidPattern = /^(?:18|[1-9])\d{8}$/u;
const confirmation = /^(#原神|#星铁|#|\*)确认恢复旧面板(?:\s+((?:18|[1-9])\d{8})(?:\s+档案\s*([1-9]\d{0,2}))?)?$/u;
const names = { gs: "原神", sr: "星铁" } as const;
const prefixes = { gs: "#", sr: "*" } as const;

export async function readLegacyPanelRecoveryEnabled(root: URL) {
  return (await readLocalConfig(root, "global")).panel_legacy_recovery === true;
}

export function matchLegacyPanelRecoveryConfirmation(message: string): { game: Game; uid?: string; profileId: number } | undefined {
  const match = confirmation.exec(message.trim());
  if (match) return { game: match[1] === "*" || match[1] === "#星铁" ? "sr" : "gs", uid: match[2], profileId: Number(match[3] ?? 1) };
}

function active(scope: Scope) {
  return !scope.signal.aborted && scope.isCurrent();
}

function scopeKey(game: Game, scope: Scope) {
  return `${scope.adapter}:${scope.bot}:${scope.user}:${game}`;
}

export function createLegacyPanelRecoveryFlow({ enabled, authorize, read = readLegacyPanelRecovery, now = Date.now }: {
  readonly enabled: () => Promise<boolean>;
  readonly authorize: Authorize;
  readonly read?: typeof readLegacyPanelRecovery;
  readonly now?: () => number;
}) {
  const receipts = new Map<string, Receipt>();
  let order = 0n;
  const inflight = new Set<string>();
  return {
    offer(scope: Scope): LegacyPanelRecoveryOffer {
      return async candidate => {
        if (!active(scope) || !uidPattern.test(candidate.uid)) return;
        const sequence = ++order;
        const deliveryDeadline = now() + lifetime;
        if (!await enabled().catch(() => false)) return;
        const { game, uid, profileId } = candidate;
        const key = scopeKey(game, scope);
        if (inflight.has(key)) return;
        const authority = await authorize(candidate, scope).catch(() => undefined);
        if (!authority || !await candidate.isEmpty().catch(() => false) || !active(scope) ||
            !await authority().catch(() => false) || now() >= deliveryDeadline) return;
        return {
          type: "delivery",
          message: `本机档案 ${profileId} 尚无${names[game]}面板。经你确认后，本机将把你的 QQ、${names[game]} UID ${uid} 和游戏类型发送给原旧档服务 ark.ivny.cn，只读其已经保存的角色面板。原站仍需已有该 QQ 和 UID 的验证。\n如同意，请在本好友私聊于 5 分钟内发送 ${prefixes[game]}确认恢复旧面板 ${uid} 档案${profileId}。`,
          async onDelivered() {
            const deliveredAt = now();
            if (!active(scope) || deliveredAt >= deliveryDeadline) return;
            for (const [key, receipt] of receipts) {
              if (receipt.expires <= deliveredAt) receipts.delete(key);
            }
            const previous = receipts.get(key);
            if (previous ? previous.sequence >= sequence : receipts.size >= maxPending) return;
            receipts.set(key, { sequence, expires: deliveredAt + lifetime, offer: { candidate, authority, origin: scope } });
          },
        };
      };
    },
    async confirm({ game, uid, profileId }: { readonly game: Game; readonly uid?: string; readonly profileId: number }, scope: Scope) {
      if (!active(scope)) return;
      if (!await enabled().catch(() => false)) return "本机未开启旧面板回补。";
      const key = scopeKey(game, scope);
      if (inflight.has(key)) return "这次旧面板回补正在处理。";
      const receipt = receipts.get(key);
      const offer = receipt?.offer;
      if (!receipt || !offer || receipt.expires <= now() || !active(offer.origin)) {
        if (receipt && receipt.expires <= now()) receipts.delete(key);
        else if (receipt?.offer) receipts.set(key, { sequence: receipt.sequence, expires: receipt.expires });
        return `没有待确认的旧面板回补，请先从好友私聊使用 ${prefixes[game]}更新面板。`;
      }
      if (uid !== offer.candidate.uid || profileId !== offer.candidate.profileId) return "请使用最近一条回补说明中的完整确认指令。";
      // Keep the receipt watermark until expiry so a delayed older reply cannot restore a consumed offer.
      receipts.set(key, { sequence: receipt.sequence, expires: receipt.expires });
      inflight.add(key);
      const { candidate, authority, origin } = offer;
      const signal = AbortSignal.any([scope.signal, origin.signal]);
      async function verify() {
        if (signal.aborted || !active(scope) || !active(origin) || !await enabled().catch(() => false) || !await authority()) {
          throw new Error("会话授权或配置已变化。");
        }
        signal.throwIfAborted();
      }
      try {
        await verify();
        if (!await candidate.isEmpty()) return "本机档案已出现面板或删除记录，已停止旧面板回补。";
        await verify();
        const result = await read({ game, uid, qq: String(scope.user) }, signal);
        await verify();
        if (result.state === "unverified") return "原旧档服务还未验证该 QQ 和 UID，无法读取旧私人面板。";
        if (result.state === "missing") return "原旧档服务没有这个 UID 的旧面板。";
        if (result.state !== "ready") return "旧面板暂时无法读取或格式不符，本机档案未改。";
        const added = await candidate.save(result.playerData, verify);
        await verify();
        if (added === undefined) return "本机已有面板或删除记录，已保留本机档案。";
        if (added === 0) return "旧档没有可恢复的角色，本机档案未改。";
        return `已恢复 ${added} 名${names[game]}角色的旧面板。可使用 ${prefixes[game]}面板${profileId === 1 ? "" : profileId} 查看。`;
      } catch {
        if (active(scope)) return "旧面板回补未能确认，请检查当前档案后重试。";
      } finally {
        inflight.delete(key);
      }
    },
  };
}
