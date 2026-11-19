export const extensionTokenHeader = "guoba-access-token";

export function extensionBridge(api?: { apiBase: string; legacyApiBase: string }): string {
  // This script runs in the extension frame, whose origin is opaque.
  const configuration = api ? JSON.stringify({ ...api, tokenKey: extensionTokenHeader }) : "null";
  return `(() => {
    try {
      void window.localStorage;
    } catch {
      const values = new Map();
      let nonce;
      const prefix = "#lotus-frame:";
      if (window.location?.hash.startsWith(prefix)) {
        try {
          const initial = JSON.parse(decodeURIComponent(window.location.hash.slice(prefix.length)));
          const url = new URL(window.location.href);
          url.hash = initial.hash;
          // Restore the plugin's fragment before its first script runs.
          window.history.replaceState(null, "", url.href);
          nonce = typeof initial.nonce === "string" ? initial.nonce : undefined;
          const entries = JSON.parse(initial.data);
          if (Array.isArray(entries) && entries.every((entry) =>
            Array.isArray(entry) && entry.length === 2 && entry.every((value) => typeof value === "string")
          )) {
            for (const [key, value] of entries) values.set(key, value);
          }
        } catch {
          // Legacy pages can still use the iframe's temporary storage.
        }
      }
      const save = () => {
        if (!nonce) return;
        const data = JSON.stringify([...values]);
        if (data.length <= 4096 && new TextEncoder().encode(data).byteLength <= 4096) {
          window.parent.postMessage({ type: "lotus-frame-storage", nonce, data }, window.location.origin);
        }
      };
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
          get length() { return values.size; },
          key(index) { return Array.from(values.keys())[index] ?? null; },
          getItem(key) { return values.get(String(key)) ?? null; },
          setItem(key, value) { values.set(String(key), String(value)); save(); },
          removeItem(key) { values.delete(String(key)); save(); },
          clear() { values.clear(); save(); },
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
