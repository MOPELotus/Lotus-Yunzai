import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { HoyoRequestError, withHoyoReadRetries } from "@lotus-yunzai/hoyo-client";

const internationalOrigins = new Set([
  "https://sg-public-api.hoyoverse.com",
  "https://passport-api-sg.hoyolab.com",
  "https://passport-api-us.hoyolab.com",
  "https://passport-api-eu.hoyolab.com",
  "https://api-account-os.hoyolab.com",
  "https://api-account-os.hoyoverse.com",
  "https://public-operation-hk4e-sg.hoyoverse.com",
  "https://public-operation-hkrpg-sg.hoyoverse.com",
  "https://public-operation-nap-sg.hoyoverse.com",
  "https://public-operation-common-sg.hoyoverse.com",
  "https://public-operation-hk4e.hoyoverse.com",
  "https://public-operation-hkrpg.hoyoverse.com",
  "https://public-operation-nap.hoyoverse.com",
  "https://sg-act-public-api.hoyolab.com",
  "https://sg-hk4e-api.hoyolab.com",
  "https://sg-hk4e-api.hoyoverse.com",
  "https://sg-hkrpg-api.hoyolab.com",
  "https://sg-public-api.hoyolab.com",
  "https://sg-act-nap-api.hoyolab.com",
  "https://bbs-api-os.hoyolab.com",
  "https://sg-cg-api.hoyoverse.com",
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
  if (configured === undefined) return withHoyoReadRetries(fetch);
  const proxy = parseProxy(configured);
  if (!proxy) console.warn($t("lib.hoyolab-network.text_ca5400b486"));

  return withHoyoReadRetries(async (endpoint: URL, init: RequestInit) => {
    if (!internationalOrigins.has(endpoint.origin)) return fetch(endpoint, init);
    if (!proxy) throw new HoyoRequestError("transport", $t("lib.hoyolab-network.text_f9821ec8c5"));
    return fetch(endpoint, { ...init, redirect: "error", proxy: { url: proxy, headers: {}, respectNoProxy: false } });
  });
}
