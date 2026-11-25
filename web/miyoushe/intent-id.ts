type RandomSource = {
  randomUUID?: () => string;
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
};

/** Secure contexts expose randomUUID; LAN HTTP still exposes getRandomValues. */
export function createIntentId(source: RandomSource | undefined = globalThis.crypto): string | undefined {
  try {
    if (typeof source?.randomUUID === "function") return source.randomUUID();
  } catch { /* Fall back to the same browser's cryptographic random source. */ }
  try {
    if (typeof source?.getRandomValues !== "function") return;
    const bytes = source.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch { return; }
}
