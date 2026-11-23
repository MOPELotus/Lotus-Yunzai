type Game = "gs" | "sr";
type Transport = (url: URL, init: RequestInit) => Promise<Response>;

export type PublicGameSignature = {
  readonly state: "ready";
  readonly signature: string;
  readonly ttlSeconds: number;
} | {
  readonly state: "no-signature" | "unavailable";
  readonly ttlSeconds: number;
};

const endpoints = {
  gs: { base: "https://enka.network/api/uid/", maximum: 64 * 1024, fallbackTtl: 60 },
  sr: { base: "https://api.mihomo.me/sr_info/", maximum: 512 * 1024, fallbackTtl: 120 },
} as const;
const uidPattern = /^(?:18|[1-9])\d{8}$/u;
const maxTtl = 86_400;

function object(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function integerSeconds(value: unknown) {
  const seconds = typeof value === "string" && /^\d{1,5}$/u.test(value) ? Number(value) : value;
  if (typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= maxTtl) return seconds;
}

function limitSeconds(header: string | null, fallback: number) {
  if (!header) return fallback;
  if (/^\d{1,10}$/u.test(header)) return Math.min(maxTtl, Math.max(Number(header), fallback));
  // Consider a valid Retry-After date as well as relative seconds.
  const date = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(header) ? Date.parse(header) : NaN;
  return Number.isFinite(date) ? Math.min(maxTtl, Math.max(fallback, Math.ceil((date - Date.now()) / 1000))) : fallback;
}

function hasUid(value: unknown, uid: string) {
  return (typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value)) && String(value) === uid;
}

async function readJson(response: Response, maximum: number, signal: AbortSignal) {
  const mediaType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!response.body || mediaType !== "application/json" || Number(response.headers.get("Content-Length")) > maximum) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return object(JSON.parse(text + decoder.decode()) as unknown);
      size += value.byteLength;
      if (size > maximum) return;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

export async function readPublicGameSignature(game: Game, uid: string, signal: AbortSignal,
  transport: Transport = fetch): Promise<PublicGameSignature> {
  if (game !== "gs" && game !== "sr") return { state: "unavailable", ttlSeconds: 120 };
  const { base, maximum, fallbackTtl } = endpoints[game];
  const unavailable = { state: "unavailable", ttlSeconds: fallbackTtl } as const;
  if (typeof uid !== "string" || !uidPattern.test(uid) || signal.aborted) return unavailable;
  const endpoint = new URL(game === "gs" ? `${uid}/?info` : uid, base);
  const address = endpoint.href;
  try {
    const active = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
    const response = await transport(endpoint, {
      method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: active,
      headers: { Accept: "application/json", "User-Agent": "Lotus-Yunzai (public game profile)" },
    });
    const originChanged = response.redirected || !!response.url && response.url !== address;
    if (active.aborted || originChanged || !response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (active.aborted || originChanged) return unavailable;
      if (response.status === 404) return { state: "no-signature", ttlSeconds: fallbackTtl };
      if (response.status === 429) return { state: "unavailable", ttlSeconds: limitSeconds(response.headers.get("Retry-After"), fallbackTtl) };
      return unavailable;
    }
    const raw = await readJson(response, maximum, active);
    if (!raw) return unavailable;
    // Mihomo does not consistently declare a TTL. Treat the fallback as a retry delay, not proof of freshness.
    const ttlSeconds = integerSeconds(raw.ttl) ?? fallbackTtl;
    const player = object(game === "gs" ? raw.playerInfo : raw.detailInfo);
    if (game === "gs") {
      if (!hasUid(raw.uid, uid) || (player && Object.hasOwn(player, "uid") && !hasUid(player.uid, uid))) return unavailable;
      if (raw.profileUnavailable === true) return { state: "no-signature", ttlSeconds };
    } else if (!hasUid(player?.uid, uid) || (Object.hasOwn(raw, "uid") && !hasUid(raw.uid, uid))) {
      return unavailable;
    }
    if (!player) return unavailable;
    const signature = player.signature;
    if (signature === undefined || signature === null || (typeof signature === "string" && !signature.trim())) {
      return { state: "no-signature", ttlSeconds };
    }
    if (typeof signature !== "string" || signature.length > 256 || !signature.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(signature)) {
      return unavailable;
    }
    return { state: "ready", signature, ttlSeconds };
  } catch {
    return unavailable;
  }
}
