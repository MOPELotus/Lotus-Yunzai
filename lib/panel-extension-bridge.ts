export const extensionTokenHeader = "guoba-access-token";
export const extensionTicketLifetimeMs = 5 * 60_000;

export function extensionBridge(api?: {
  apiBase: string;
  relativeApi: string;
  legacyApiBase: string;
  legacyRoutes: readonly string[];
}): string {
  // This script runs in the extension frame, whose origin is opaque.
  const configuration = api ? JSON.stringify({ ...api, tokenKey: extensionTokenHeader }) : "null";
  return `(() => {
    let nonce;
    try {
      void window.localStorage;
    } catch {
      const values = new Map();
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
    let token = new URLSearchParams(location.search).get("token") || "";
    const { apiBase: internalApi, relativeApi, legacyApiBase, legacyRoutes, tokenKey } = config;
    const script = document.currentScript.src;
    const apiBase = new URL("../../" + relativeApi, script).pathname;
    const publicRoot = new URL("../../../", script).pathname.slice(0, -1);
    window.__GUOBA__ = { apiBase, token, tokenKey };
    const refreshAfterMs = ${extensionTicketLifetimeMs - 30_000};
    let renewAt = Date.now() + refreshAfterMs;
    let renewal;
    function renewToken() {
      if (!nonce || Date.now() < renewAt) return;
      renewal ??= new Promise((resolve) => {
        const { port1, port2 } = new MessageChannel();
        const finish = () => {
          clearTimeout(timeout);
          port1.close();
          resolve();
        };
        const timeout = setTimeout(finish, 5_000);
        port1.onmessage = ({ data }) => {
          if (typeof data?.token === "string" && /^\\d{13}\\.[0-9a-f]{64}$/.test(data.token)) {
            token = data.token;
            renewAt = Date.now() + refreshAfterMs;
            window.__GUOBA__.token = token;
          }
          finish();
        };
        window.parent.postMessage({ type: "lotus-frame-api-renew", nonce }, window.location.origin, [port2]);
      }).finally(() => { renewal = undefined; });
      return renewal;
    }
    const original = window.fetch.bind(window);
    const legacy = "/guoba/api";
    const includesPath = (path, prefix) => path === prefix || path.startsWith(prefix + "/");
    const legacyPaths = legacyRoutes.map(route => {
      const url = new URL(location.href);
      url.pathname = route;
      return url.pathname;
    }).sort((left, right) => right.length - left.length);
    window.fetch = async (input, init) => {
      const source = new Request(input, init);
      const target = new URL(source.url);
      if (target.origin !== location.origin) return original(source);
      const path = publicRoot && includesPath(target.pathname, publicRoot + legacy)
        ? target.pathname.slice(publicRoot.length) : target.pathname;
      if (includesPath(path, legacyApiBase)) {
        target.pathname = apiBase + path.slice(legacyApiBase.length);
      } else if (includesPath(path, legacy) && !includesPath(path, legacy + "/custom")) {
        target.pathname = apiBase + path.slice(legacy.length);
      } else if (includesPath(target.pathname, internalApi)) {
        target.pathname = apiBase + target.pathname.slice(internalApi.length);
      } else if (!includesPath(target.pathname, apiBase)) {
        // Old extensions can hard-code a different mount. Match only an exact
        // registered route suffix and leave explicit API owners alone.
        if (target.pathname.includes("/api/custom/")) return original(source);
        const route = legacyPaths.find(route => target.pathname.endsWith("/api" + route));
        if (!route) return original(source);
        target.pathname = apiBase + route;
      }
      await renewToken();
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
