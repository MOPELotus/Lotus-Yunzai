export const extensionTokenHeader = "guoba-access-token";

export function extensionBridge(api?: { apiBase: string; legacyApiBase: string }): string {
  // This script runs in the extension frame, whose origin is opaque.
  const configuration = api ? JSON.stringify({ ...api, tokenKey: extensionTokenHeader }) : "null";
  return `(() => {
    try {
      void window.localStorage;
    } catch {
      // Legacy pages can use these preferences for the lifetime of this document.
      const values = new Map();
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
          get length() { return values.size; },
          key(index) { return Array.from(values.keys())[index] ?? null; },
          getItem(key) { return values.get(String(key)) ?? null; },
          setItem(key, value) { values.set(String(key), String(value)); },
          removeItem(key) { values.delete(String(key)); },
          clear() { values.clear(); },
        },
      });
    }
    const config = ${configuration};
    if (!config) return;
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
