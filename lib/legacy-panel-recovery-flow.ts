import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
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
const names = { gs: $t("lib.legacy-panel-recovery-flow.text_d1597c51ed"), sr: $t("lib.legacy-panel-recovery-flow.text_a2927891f0") } as const;
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
          message: $t("lib.legacy-panel-recovery-flow.text_f92308a89a", { "profileId": profileId, "value2": names[game], "value3": names[game], "uid": uid, "value5": prefixes[game], "value6": uid, "value7": profileId }),
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
      if (!await enabled().catch(() => false)) return $t("lib.legacy-panel-recovery-flow.text_98365d4ff0");
      const key = scopeKey(game, scope);
      if (inflight.has(key)) return $t("lib.legacy-panel-recovery-flow.text_68bbedd031");
      const receipt = receipts.get(key);
      const offer = receipt?.offer;
      if (!receipt || !offer || receipt.expires <= now() || !active(offer.origin)) {
        if (receipt && receipt.expires <= now()) receipts.delete(key);
        else if (receipt?.offer) receipts.set(key, { sequence: receipt.sequence, expires: receipt.expires });
        return $t("lib.legacy-panel-recovery-flow.text_6c5a602274", { "value1": prefixes[game] });
      }
      if (uid !== offer.candidate.uid || profileId !== offer.candidate.profileId) return $t("lib.legacy-panel-recovery-flow.text_44f252b100");
      // Keep the receipt watermark until expiry so a delayed older reply cannot restore a consumed offer.
      receipts.set(key, { sequence: receipt.sequence, expires: receipt.expires });
      inflight.add(key);
      const { candidate, authority, origin } = offer;
      const signal = AbortSignal.any([scope.signal, origin.signal]);
      async function verify() {
        if (signal.aborted || !active(scope) || !active(origin) || !await enabled().catch(() => false) || !await authority()) {
          throw new Error($t("lib.legacy-panel-recovery-flow.text_4eed6e208c"));
        }
        signal.throwIfAborted();
      }
      try {
        await verify();
        if (!await candidate.isEmpty()) return $t("lib.legacy-panel-recovery-flow.text_44e239a400");
        await verify();
        const result = await read({ game, uid, qq: String(scope.user) }, signal);
        await verify();
        if (result.state === "unverified") return $t("lib.legacy-panel-recovery-flow.text_22cedd75f9");
        if (result.state === "missing") return $t("lib.legacy-panel-recovery-flow.text_79668ffe98");
        if (result.state !== "ready") return $t("lib.legacy-panel-recovery-flow.text_e5586a298a");
        const added = await candidate.save(result.playerData, verify);
        await verify();
        if (added === undefined) return $t("lib.legacy-panel-recovery-flow.text_0848fdfa35");
        if (added === 0) return $t("lib.legacy-panel-recovery-flow.text_63e3decc12");
        return $t("lib.legacy-panel-recovery-flow.text_7c878dc9be", { "added": added, "value2": names[game], "value3": prefixes[game], "value4": profileId === 1 ? "" : profileId });
      } catch {
        if (active(scope)) return $t("lib.legacy-panel-recovery-flow.text_539674dc34");
      } finally {
        inflight.delete(key);
      }
    },
  };
}
