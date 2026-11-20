const localOrigin = "http://lotus.invalid";
const reserved = /^\/(?:status|panel|File|Media|OneBotv11|exit|captcha\/manual)(?:\/|$)/iu;
const unsafe = /[\\\u0000-\u001f\u007f-\u009f]|%(?:0[0-9a-f]|1[0-9a-f]|5c|7f)/iu;
const networkPath = /^\/(?:\/|%2f)/iu;
const invalid = () => new Error("config/server.yaml 的 redirect 须为安全的 HTTP(S) 地址或站内绝对路径。");

export function readServerRedirect(value: unknown): string | undefined {
  if (value === undefined || value === null || value === false) return;
  if (typeof value !== "string") throw invalid();
  const source = value.trim();
  if (!source) return;
  if (unsafe.test(value) || /\s/u.test(source)) throw invalid();

  if (source.startsWith("/")) {
    const parsed = URL.parse(source, localOrigin);
    if (networkPath.test(source) || !parsed || parsed.origin !== localOrigin || networkPath.test(parsed.pathname)) {
      throw invalid();
    }
    return parsed.href.slice(localOrigin.length);
  }

  const authority = /^https?:\/\/([^/?#]+)/iu.exec(source)?.[1];
  const parsed = authority && !authority.includes("@") ? URL.parse(source) : null;
  if (!parsed || !parsed.hostname || parsed.username || parsed.password) throw invalid();
  return parsed.href;
}

export function isReservedServerPath(pathname: string): boolean {
  try {
    return reserved.test(decodeURIComponent(pathname));
  } catch {
    return true;
  }
}

export function createServerRedirect(location?: string) {
  const configured = readServerRedirect(location);
  return (request: Request): Response | undefined => {
    if (!configured || (request.method !== "GET" && request.method !== "HEAD") || request.headers.has("Upgrade")) return;
    if (isReservedServerPath(new URL(request.url).pathname)) return;
    return new Response(null, { status: 302, headers: { Location: configured, "Cache-Control": "no-store" } });
  };
}
