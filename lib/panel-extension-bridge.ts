export const extensionTokenHeader = "guoba-access-token";

export function extensionBridge(apiBase: string, legacyApiBase: string): string {
  // This script runs in the extension frame, whose origin is opaque.
  const configuration = JSON.stringify({ apiBase, legacyApiBase, tokenKey: extensionTokenHeader });
  return `(() => {
    const config = ${configuration};
    const token = new URLSearchParams(location.search).get("token") || "";
    const { apiBase, legacyApiBase, tokenKey } = config;
    window.__GUOBA__ = { apiBase, token, tokenKey };
    const original = window.fetch.bind(window);
    const legacy = "/guoba/api";
    const includesPath = (path, prefix) => path === prefix || path.startsWith(prefix + "/");
    window.fetch = async (input, init) => {
      const source = new Request(input, init);
      const target = new URL(source.url);
      if (target.origin !== location.origin) return original(source);
      if (includesPath(target.pathname, legacyApiBase)) {
        target.pathname = apiBase + target.pathname.slice(legacyApiBase.length);
      } else if (includesPath(target.pathname, legacy) && !includesPath(target.pathname, legacy + "/custom")) {
        target.pathname = apiBase + target.pathname.slice(legacy.length);
      } else if (!includesPath(target.pathname, apiBase)) {
        return original(source);
      }
      const headers = new Headers(source.headers);
      headers.set(tokenKey, token);
      return original(target, {
        method: source.method, headers, body: source.body ? await source.arrayBuffer() : undefined,
        signal: source.signal, mode: "cors", credentials: "omit", redirect: "error",
      });
    };
  })();`;
}

export function attachExtensionBridge(html: string, src: string): string {
  const doctype = /^\s*<!doctype\s+html\s*>/iu.exec(html)?.[0] ?? "";
  const script = `<script src="${src}"></script>`;
  return `${doctype || "<!doctype html>"}${script}${html.slice(doctype.length)}`;
}
