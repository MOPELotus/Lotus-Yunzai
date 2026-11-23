import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const panelTransferPath = "/lotus/panel-transfer";
export const panelTransferLifetime = 10 * 60_000;
export const maxPanelTransferBytes = 2 * 1024 * 1024;
const nonceBytes = 12;
const tagBytes = 16;
const timeBytes = 8;
const maxEnvelope = nonceBytes + tagBytes + timeBytes + maxPanelTransferBytes;
const transferVersion = "LPT1";
const receiptLimit = 128;
const storageLimit = 16 * 1024 * 1024;

export type PanelTransferOwner = {
  readonly game: "gs" | "sr";
  readonly qq: string;
  readonly uid: string;
};
type TransferFetch = (url: URL, init: RequestInit) => Promise<Response>;
type TransferRecord = {
  readonly proof: Buffer;
  readonly acknowledgement: Buffer;
  readonly expiresAt: number;
  envelope?: Uint8Array;
};

function exactCode(text: string, size: number) {
  if (!/^[A-Za-z0-9_-]+$/u.test(text) || text.length !== Math.ceil(size * 8 / 6)) return;
  const bytes = Buffer.from(text, "base64url");
  if (bytes.byteLength === size && bytes.toString("base64url") === text) return bytes;
}

export function panelTransferOrigin(value: string) {
  if (!value || value.length > 255 || /[\p{Cc}\p{Cf}\\\s]/u.test(value)) return;
  const url = URL.parse(value);
  if (url?.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/") return url.origin;
}

function ownerIdentity({ game, qq, uid }: PanelTransferOwner) {
  if ((game !== "gs" && game !== "sr") || !/^[1-9]\d{0,15}$/u.test(qq) || !/^[1-9]\d{8,9}$/u.test(uid)) return;
  return `${game}:${qq}:${uid}`;
}

function capabilityPayload(id: string, owner: string) {
  return `${transferVersion}:${id}:${owner}`;
}

function derive(key: Buffer, purpose: string, payload: string) {
  return createHmac("sha256", key).update(purpose).update("\0").update(payload).digest();
}

function noCacheResponse(body: Uint8Array | null, status: number) {
  return new Response(body ? Uint8Array.from(body) : null, { status, headers: {
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    ...(body && { "Content-Type": "application/octet-stream" }),
  } });
}

export function createPanelTransferSource({ publicOrigin, signal, now = Date.now }: {
  readonly publicOrigin?: string;
  readonly signal: AbortSignal;
  readonly now?: () => number;
}) {
  const origin = publicOrigin && panelTransferOrigin(publicOrigin);
  const records = new Map<string, TransferRecord>();
  let storedBytes = 0;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  function clearEnvelope(record: TransferRecord) {
    if (record.envelope) storedBytes -= record.envelope.byteLength;
    record.envelope = undefined;
  }
  function clean() {
    clearTimeout(expiry);
    let next = Infinity;
    for (const [id, record] of records) {
      if (record.expiresAt <= now()) {
        clearEnvelope(record);
        records.delete(id);
      } else {
        next = Math.min(next, record.expiresAt);
      }
    }
    if (Number.isFinite(next)) {
      expiry = setTimeout(clean, Math.max(1, next - now()));
      expiry.unref();
    }
  }
  signal.addEventListener("abort", () => {
    clearTimeout(expiry);
    records.clear();
    storedBytes = 0;
  }, { once: true });

  return {
    enabled: Boolean(origin),
    offer(owner: PanelTransferOwner, data: Uint8Array) {
      const identity = ownerIdentity(owner);
      if (!origin || signal.aborted || !identity || !data.byteLength || data.byteLength > maxPanelTransferBytes) return;
      clean();
      if (records.size >= receiptLimit || storedBytes + data.byteLength + nonceBytes + tagBytes + timeBytes > storageLimit) return;
      const id = randomBytes(18).toString("base64url");
      const key = randomBytes(32);
      const nonce = randomBytes(nonceBytes);
      const payload = capabilityPayload(id, identity);
      const expiresAt = now() + panelTransferLifetime;
      const expiryBytes = Buffer.alloc(timeBytes);
      expiryBytes.writeBigUInt64BE(BigInt(expiresAt));
      const cipher = createCipheriv("aes-256-gcm", derive(key, "encryption", payload), nonce);
      cipher.setAAD(Buffer.from(payload));
      const encrypted = Buffer.concat([cipher.update(expiryBytes), cipher.update(data), cipher.final()]);
      const envelope = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
      records.set(id, { proof: derive(key, "claim", payload), acknowledgement: derive(key, "ack", payload), expiresAt, envelope });
      storedBytes += envelope.byteLength;
      clean();
      return [transferVersion, Buffer.from(origin).toString("base64url"), id, key.toString("base64url")].join(".");
    },
    withdraw(code: string, owner: PanelTransferOwner) {
      const parsed = parseCapability(code);
      const identity = ownerIdentity(owner);
      if (!parsed || !identity || parsed.origin !== origin) return;
      const record = records.get(parsed.id);
      if (!record || !timingSafeEqual(record.proof, derive(parsed.key, "claim", capabilityPayload(parsed.id, identity)))) return;
      clearEnvelope(record);
      records.delete(parsed.id);
      clean();
    },
    serve(request: Request): Response | undefined {
      const url = new URL(request.url);
      if (url.pathname !== panelTransferPath) return;
      if (!origin || signal.aborted) return noCacheResponse(null, 404);
      if (request.method !== "POST") return noCacheResponse(null, 405);
      if (url.search || request.body || request.signal.aborted) return noCacheResponse(null, 400);
      const id = request.headers.get("X-Lotus-Panel-Transfer") ?? "";
      const operation = request.headers.get("X-Lotus-Panel-Operation");
      const header = /^PanelTransfer ([A-Za-z0-9_-]+)$/u.exec(request.headers.get("Authorization") ?? "");
      const proof = header && exactCode(header[1]!, 32);
      if (!proof || !exactCode(id, 18) || (operation !== "claim" && operation !== "ack")) return noCacheResponse(null, 400);
      const record = records.get(id);
      if (!record || record.expiresAt <= now() ||
          !timingSafeEqual(proof, operation === "claim" ? record.proof : record.acknowledgement)) return noCacheResponse(null, 404);
      if (operation === "ack") {
        clearEnvelope(record);
        return noCacheResponse(null, 204);
      }
      return record.envelope ? noCacheResponse(record.envelope, 200) : noCacheResponse(null, 410);
    },
  };
}

async function readEnvelope(response: Response, signal: AbortSignal) {
  if (!response.body || response.headers.get("Content-Type") !== "application/octet-stream" ||
      Number(response.headers.get("Content-Length")) > maxEnvelope) return;
  const reader = response.body.getReader();
  const pieces: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxEnvelope) return;
      pieces.push(value);
    }
    if (length > nonceBytes + tagBytes + timeBytes) return Buffer.concat(pieces, length);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function openEnvelope(record: Buffer, key: Buffer, payload: string, now: number) {
  try {
    const cipher = createDecipheriv("aes-256-gcm", derive(key, "encryption", payload), record.subarray(0, nonceBytes));
    cipher.setAAD(Buffer.from(payload));
    cipher.setAuthTag(record.subarray(nonceBytes, nonceBytes + tagBytes));
    const clear = Buffer.concat([cipher.update(record.subarray(nonceBytes + tagBytes)), cipher.final()]);
    const expires = clear.readBigUInt64BE();
    // Small source/receiver clock drift is allowed for the upper bound. The source enforces the actual expiration.
    if (expires > BigInt(now) && expires <= BigInt(now + panelTransferLifetime + 30_000)) return clear.subarray(timeBytes);
  } catch {
    return;
  }
}

type ClaimResult = { readonly state: "invalid" | "unavailable" | "expired" | "confirmed" } |
  { readonly state: "ready"; readonly bytes: Uint8Array; acknowledge(signal: AbortSignal): Promise<boolean> };

function parseCapability(code: string) {
  if (code.length > 440) return;
  const fields = code.split(".");
  if (fields.length !== 4 || fields[0] !== transferVersion) return;
  const [, address, id, keyText] = fields as [string, string, string, string];
  const key = exactCode(keyText, 32);
  if (!key || !exactCode(id, 18) || !/^[A-Za-z0-9_-]{1,340}$/u.test(address)) return;
  const name = Buffer.from(address, "base64url");
  if (name.toString("base64url") !== address) return;
  const origin = panelTransferOrigin(name.toString("utf8"));
  if (origin) return { origin, id, key };
}

export function createPanelTransferReceiver({ peers, transport = fetch, now = Date.now }: {
  readonly peers: readonly string[];
  readonly transport?: TransferFetch;
  readonly now?: () => number;
}) {
  const trusted = new Set(peers.map(panelTransferOrigin).filter(origin => origin !== undefined));

  return async (code: string, owner: PanelTransferOwner, signal: AbortSignal): Promise<ClaimResult> => {
    const identity = ownerIdentity(owner);
    const parsed = parseCapability(code);
    if (!identity || !parsed || !trusted.has(parsed.origin)) return { state: "invalid" };
    const { origin, id, key } = parsed;
    const payload = capabilityPayload(id, identity);
    const url = new URL(panelTransferPath, origin);

    async function request(operation: "claim" | "ack", signal: AbortSignal) {
      signal.throwIfAborted();
      return transport(url, {
        method: "POST", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal,
        headers: { "X-Lotus-Panel-Transfer": id, "X-Lotus-Panel-Operation": operation,
          "Authorization": `PanelTransfer ${derive(key, operation, payload).toString("base64url")}` },
      });
    }
    try {
      const active = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
      const response = await request("claim", active);
      if (response.status !== 200 || response.redirected) {
        await response.body?.cancel().catch(() => undefined);
        if (response.redirected) return { state: "unavailable" };
        if (response.status === 410) return { state: "confirmed" };
        return { state: response.status === 404 ? "expired" : "unavailable" };
      }
      const envelope = await readEnvelope(response, active);
      if (!envelope) {
        await response.body?.cancel().catch(() => undefined);
        return { state: "invalid" };
      }
      const bytes = openEnvelope(envelope, key, payload, now());
      if (!bytes) return { state: "invalid" };
      return { state: "ready", bytes, async acknowledge(signal: AbortSignal) {
        try {
          const response = await request("ack", AbortSignal.any([signal, AbortSignal.timeout(12_000)]));
          await response.body?.cancel().catch(() => undefined);
          return !response.redirected && response.status === 204;
        } catch {
          return false;
        }
      } };
    } catch {
      return { state: "unavailable" };
    }
  };
}
