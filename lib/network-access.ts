import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

/** Only loopback, RFC1918, link-local and IPv6 ULA are trusted without a token. */
export function isInternalAddress(address: string | undefined): boolean {
  const value = address?.split("%", 1)[0]?.toLowerCase();
  if (!value) return false;
  if (isIP(value) === 4) {
    const [a, b] = value.split(".").map(Number);
    return a === 127 || a === 10 || a === 192 && b === 168 || a === 172 && b! >= 16 && b! <= 31 || a === 169 && b === 254;
  }
  if (isIP(value) !== 6) return false;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const [head, tail] = normalized.split("::");
  const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const words = tail === undefined ? left.map(word => parseInt(word, 16))
    : [...left.map(word => parseInt(word, 16)), ...Array(8 - left.length - right.length).fill(0), ...right.map(word => parseInt(word, 16))] as number[];
  if (words.length !== 8) return false;
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return isInternalAddress(`${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`);
  }
  return words.slice(0, 7).every(word => word === 0) && words[7] === 1 ||
    (words[0]! & 0xfe00) === 0xfc00 || (words[0]! & 0xffc0) === 0xfe80;
}
export function isDirectInternalRequest(request: Request, peer: string | undefined): boolean {
  // Forwarded headers never grant LAN trust. A reverse-proxied connection requires authentication.
  return isInternalAddress(peer) && !["forwarded", "x-forwarded-for", "x-real-ip"].some(name => request.headers.has(name));
}
export function authorizedProtocolRequest(request: Request, required: Headers, peer: string | undefined): boolean {
  const configured = [...required.keys()];
  if (isDirectInternalRequest(request, peer) && !configured.some(key => request.headers.has(key))) return true;
  return configured.length > 0 && configured.every(key => request.headers.get(key) === required.get(key));
}
export function listenerOrigins(hostname: string, port: number | undefined, protocol: "http" | "https" | "ws" | "wss"): string[] {
  if (port === undefined) return [];
  const wildcard = ["0.0.0.0", "::", "[::]"].includes(hostname);
  const addresses = wildcard ? ["127.0.0.1", ...Object.values(networkInterfaces()).flatMap(entries =>
    (entries ?? []).filter(entry => !entry.internal && isInternalAddress(entry.address)).map(entry => entry.address))] : [hostname];
  return [...new Set(addresses)].map(address => `${protocol}://${address.includes(":") && !address.startsWith("[") ? `[${address}]` : address}:${port}`);
}
