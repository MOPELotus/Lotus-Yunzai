import { HoyoRequestError } from "@lotus-yunzai/hoyo-client";

const internationalOrigins = new Set([
  "https://passport-api-sg.hoyolab.com",
  "https://passport-api-us.hoyolab.com",
  "https://passport-api-eu.hoyolab.com",
  "https://api-account-os.hoyolab.com",
  "https://sg-act-public-api.hoyolab.com",
  "https://sg-hk4e-api.hoyolab.com",
  "https://sg-hkrpg-api.hoyolab.com",
  "https://sg-public-api.hoyolab.com",
  "https://sg-act-nap-api.hoyolab.com",
  "https://bbs-api-os.hoyolab.com",
]);

function parseProxy(address: unknown): URL | undefined {
  if (typeof address !== "string") return;
  try {
    const url = new URL(address.trim());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.pathname === "/" && !url.search && !url.hash) return url;
  } catch {
    return;
  }
}

export function hoyoTransportForBot(proxyAddress: unknown) {
  const configured = proxyAddress == null || proxyAddress === false ||
    (typeof proxyAddress === "string" && proxyAddress.trim() === "") ? undefined : proxyAddress;
  if (configured === undefined) return fetch;
  const proxy = parseProxy(configured);
  if (!proxy) console.warn("[HoYoLAB] bot.yaml 的 proxyAddress 无效，国际服请求已停用。");

  return async (endpoint: URL, init: RequestInit) => {
    if (!internationalOrigins.has(endpoint.origin)) return fetch(endpoint, init);
    if (!proxy) throw new HoyoRequestError("transport", "bot.yaml 的国际服代理地址无效。");
    return fetch(endpoint, { ...init, redirect: "error", proxy: { url: proxy, headers: {}, respectNoProxy: false } });
  };
}
