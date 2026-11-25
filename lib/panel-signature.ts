import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoleJsonArchive, type AcquireRoleArchiveLock } from "@lotus-yunzai/storage";
import { readPublicGameSignature } from "./panel-signature-source.ts";

type Game = "gs" | "sr";
type Action = "begin" | "verify" | "revoke" | "export";
type Scope = { readonly game: Game; readonly adapter: "onebot" | "milky"; readonly bot: number; readonly user: number };
type Session = Omit<Scope, "game"> & { readonly signal: AbortSignal; readonly isCurrent: () => boolean };
type Pending = { readonly state: "pending"; readonly uid: string; readonly digest: string; readonly expires: number;
  readonly nextCheck: number; readonly delivered: boolean };
type Verified = { readonly state: "verified"; readonly uid: string; readonly generation: string; readonly expires: number };
type Proof = Pending | Verified;
type Delivery = { readonly type: "delivery"; readonly message: string; readonly onDelivered: () => Promise<void> };

const day = 24 * 60 * 60_000;
const verifiedLifetime = 30 * 60_000;
const uidPattern = /^(?:18|[1-9])\d{8}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const command = /^(?:(#)(原神|星铁)|(#|\*))(绑定UID|验证UID|取消验证UID)(?:\s*(\d{1,12}))?$/iu;
const oldOrder = /^#(绑定|验证|取消验证)(原神|星铁)UID(?:\s*(\d{1,12}))?$/iu;
const signedExport = /^(?:(#)(原神|星铁)|(#|\*))导出面板\s+(?:UID\s*)?((?:18|[1-9])\d{8})$/iu;
const names = { gs: "原神", sr: "星铁" } as const;
const hosts = { gs: "Enka（enka.network）", sr: "Mihomo（api.mihomo.me）" } as const;
const actions = { 绑定uid: "begin", 验证uid: "verify", 取消验证uid: "revoke" } as const;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function matchPanelSignatureCommand(message: string): { readonly game: Game; readonly action: Action; readonly uid?: string } | undefined {
  const input = message.trim();
  const legacy = oldOrder.exec(input);
  if (legacy) {
    return { game: legacy[2] === "星铁" ? "sr" : "gs", action: actions[`${legacy[1]}uid` as keyof typeof actions], uid: legacy[3] };
  }
  const match = command.exec(input);
  if (match) {
    return { game: match[2] === "星铁" || match[3] === "*" ? "sr" : "gs",
      action: actions[match[4]!.toLowerCase() as keyof typeof actions], uid: match[5] };
  }
  const exported = signedExport.exec(input);
  if (exported) return { game: exported[2] === "星铁" || exported[3] === "*" ? "sr" : "gs", action: "export", uid: exported[4] };
}

export const panelSignatureFeatures = {
  gs: ["[genshin] 角色面板", "genshin", "@lotus-yunzai/genshin"],
  sr: ["[starrail] 角色面板", "starrail", "@lotus-yunzai/starrail"],
} as const;

export function containsPanelSignatureChallenge(text: string) {
  return /(?:^|[^A-Za-z0-9])LY-[0-9a-f]{16}(?![A-Za-z0-9])/iu.test(text);
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function storedProof(input: unknown, scope: Scope): Proof | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const record = input as Record<string, unknown>;
  if (record.version !== 1 || record.bot !== scope.bot || record.user !== scope.user ||
      record.adapter !== scope.adapter || record.game !== scope.game || typeof record.uid !== "string" ||
      !uidPattern.test(record.uid) || !positive(record.expires)) return;
  if (record.state === "pending" && typeof record.delivered === "boolean" && typeof record.digest === "string" && digestPattern.test(record.digest) &&
      positive(record.nextCheck) && record.nextCheck <= record.expires) {
    return { state: "pending", uid: record.uid, digest: record.digest, expires: record.expires,
      nextCheck: record.nextCheck, delivered: record.delivered };
  }
  if (record.state === "verified" && typeof record.generation === "string" && digestPattern.test(record.generation)) {
    return { state: "verified", uid: record.uid, generation: record.generation, expires: record.expires };
  }
}

export function createPanelSignatureService(lock: AcquireRoleArchiveLock, {
  directory = fileURLToPath(new URL("../data/panel-signatures/", import.meta.url)),
  readSignature = readPublicGameSignature, now = Date.now,
  challenge = () => "LY-" + randomBytes(8).toString("hex"),
}: {
  readonly directory?: string; readonly readSignature?: typeof readPublicGameSignature;
  readonly now?: () => number; readonly challenge?: () => string;
} = {}) {
  const inflight = new Set<string>();
  function archive(scope: Scope) {
    return createRoleJsonArchive(join(directory, scope.adapter, scope.game), lock,
      { subject: "游戏签名核验", lockSuffix: "panel-signature", maxBytes: 4096, rejectNull: true });
  }
  function read(scope: Scope) {
    return archive(scope).read(String(scope.user), String(scope.bot)).then(raw => storedProof(raw, scope));
  }
  function update<Result>(scope: Scope, active: () => boolean,
    change: (proof: Proof | undefined) => { result: Result; document?: Proof | { state: "revoked" } }) {
    return archive(scope).update<Result>({ qq: String(scope.user), uid: String(scope.bot) }, async () => {
      if (!active()) throw new Error("好友会话已断开。");
    }, raw => {
      const { document, result } = change(storedProof(raw, scope));
      return { result, ...(document && { document: { version: 1, ...scope, ...document } }) };
    });
  }
  function checkScope(game: Game, session: Session) {
    const { adapter, bot, user } = session;
    if ((adapter === "onebot" || adapter === "milky") && positive(bot) && positive(user) && bot !== user) return { game, adapter, bot, user };
  }
  function activeSession(session: Session) {
    return () => !session.signal.aborted && session.isCurrent();
  }

  return {
    async authorization(game: Game, uid: string, session: Session) {
      const scope = checkScope(game, session), active = activeSession(session);
      if (!scope || !active() || !uidPattern.test(uid)) return;
      const proof = await read(scope).catch(() => undefined);
      if (proof?.state !== "verified" || proof.uid !== uid || proof.expires <= now() || !active()) return;
      return async () => {
        if (!active()) return false;
        const current = await read(scope).catch(() => undefined);
        return active() && current?.state === "verified" && current.uid === uid && current.generation === proof.generation && current.expires > now();
      };
    },
    async run({ action, game, uid }: { action: Exclude<Action, "export">; game: Game; uid?: string }, session: Session):
      Promise<string | Delivery | undefined> {
      const scope = checkScope(game, session), active = activeSession(session);
      if (!scope || !active()) return;
      const gameName = names[game];
      if (uid && !uidPattern.test(uid)) return `请填写有效的${gameName} UID。`;
      try {
        if (action === "begin") {
          if (!uid) return `请在好友私聊发送 #绑定${gameName}UID 游戏UID。`;
          const code = challenge();
          const issued = now();
          const pending: Pending = { state: "pending", uid, digest: digest(code), nextCheck: issued, expires: issued + day, delivered: false };
          await update(scope, active, () => ({ result: undefined, document: pending }));
          if (!active()) return;
          return { type: "delivery", message: `请把 UID ${uid} 的${gameName}个人签名暂时设为 ${code}。等待游戏审核和公开资料刷新后，发送 #验证${gameName}UID ${uid}。验证只向 ${hosts[game]} 查询该 UID，口令 24 小时有效。`,
            async onDelivered() {
              if (!active() || pending.expires <= now()) return;
              await update(scope, active, old => ({ result: undefined,
                ...(old?.state === "pending" && old.digest === pending.digest && old.expires === pending.expires &&
                  { document: { ...old, delivered: true } }),
              })).catch(() => undefined);
            } };
        }
        if (action === "revoke") {
          const cleared = await update(scope, active, old =>
            old && (!uid || uid === old.uid) ? { result: true, document: { state: "revoked" } } : { result: false });
          return active() ? cleared ? "本次游戏签名验证已撤回。" : "此会话没有对应的游戏签名验证。" : undefined;
        }
        const previous = await read(scope);
        if (previous?.state !== "pending" || !previous.delivered || previous.expires <= now() || (uid && uid !== previous.uid)) {
          return active() ? `没有对应的待验证口令，请先发 #绑定${gameName}UID 游戏UID。` : undefined;
        }
        const key = `${game}:${previous.uid}`;
        if (inflight.has(key)) return "此游戏 UID 的签名正在查询。";
        const waited = previous.nextCheck - now();
        if (waited > 0) return `公开资料可能仍在缓存，请在 ${Math.ceil(waited / 1000)} 秒后重试。`;
        inflight.add(key);
        try {
          if (!active()) return;
          const result = await readSignature(game, previous.uid, session.signal);
          if (!active()) return;
          const matched = result.state === "ready" &&
            timingSafeEqual(Buffer.from(previous.digest, "hex"), Buffer.from(digest(result.signature.trim()), "hex"));
          const ttl = Number.isFinite(result.ttlSeconds) ? Math.min(Math.max(Math.ceil(result.ttlSeconds), 15), day / 1000) : 60;
          const outcome = await update<"ok" | "retry" | "changed">(scope, active, old => {
            const checked = now();
            if (old?.state !== "pending" || old.digest !== previous.digest || old.uid !== previous.uid || old.expires <= checked) {
              return { result: "changed" };
            }
            if (matched) return { result: "ok", document: { state: "verified", uid: old.uid, generation: old.digest, expires: checked + verifiedLifetime } };
            return { result: "retry", document: { ...old, nextCheck: Math.min(old.expires, checked + ttl * 1000) } };
          });
          if (!active()) return;
          if (outcome === "ok") return `已验证 UID ${previous.uid} 的${gameName}签名。可以改回签名，并在 30 分钟内从此好友私聊发送 #${gameName}导出面板 ${previous.uid}。`;
          if (outcome === "changed") return "签名口令已更新或撤回，请按最近一条确认消息操作。";
          return result.state === "unavailable" ? "公开签名服务暂不可用，请稍后重试。"
            : `尚未读到匹配签名。请核对游戏中保存的签名和公开资料，${ttl} 秒后重试。`;
        } finally { inflight.delete(key); }
      } catch {
        if (active()) return "游戏签名验证暂不可用，请稍后重试。";
      }
    },
  };
}
