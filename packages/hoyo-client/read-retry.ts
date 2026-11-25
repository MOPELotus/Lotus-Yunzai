import { withReadRetries } from '@lotus-yunzai/http';
import type { HoyoTransport } from './credentials.ts';
export { transientReadError, transientReadResponse } from '@lotus-yunzai/http';

/** Some legacy GET routes redeem rewards, issue credentials or submit proofs. */
export function retryableRead(endpoint: URL, method: string): boolean {
  if (method === "POST") return endpoint.origin === "https://api-takumi.mihoyo.com" && endpoint.pathname === "/binding/api/genAuthKey";
  if (method !== "GET" && method !== "HEAD") return false;
  return !/(?:webExchangeCdkey|\/getLTokenBySToken|\/getCookieAccountInfoBySToken|\/getCookieTokenBySToken|\/getPostFull|\/getShareConf|\/wallet\/wallet\/get|\/ajax\.php|\/verify(?:\/|$)|createVerification|verifyVerification|createGeetest|verifyGeetest|\/sign(?:In)?(?:\/|$)|\/exchange(?:\/|$)|\/redeem(?:\/|$))/iu.test(endpoint.pathname);
}

export function withHoyoReadRetries(transport: HoyoTransport): HoyoTransport {
  return withReadRetries(transport, { canRetry: retryableRead });
}
