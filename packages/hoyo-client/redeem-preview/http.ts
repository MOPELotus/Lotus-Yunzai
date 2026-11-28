import { createTranslator as createTextTranslator } from "../../i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import https from "node:https"

export const officialJsonByteLimit = 4 * 1024 * 1024

const BBS_PATHS = ["/apihub/api/home/new", "/post/wapi/userPost", "/post/wapi/searchPosts", "/post/wapi/getPostFull"]
const OFFICIAL_ROUTES = new Map([
  ["bbs-api.mihoyo.com", BBS_PATHS],
  ["bbs-api.miyoushe.com", BBS_PATHS],
  ["bbs-api-os.hoyolab.com", ["/community/painter/wapi/circle/channel/guide/material"]],
  ["api-takumi.mihoyo.com", ["/event/miyolive/index"]],
  ["api-takumi-static.mihoyo.com", ["/event/miyolive/refreshCode"]],
])

export function officialReadTarget(url: string | URL) {
  const target = new URL(url)
  if (target.protocol !== "https:" || target.username || target.password || target.port
      || !OFFICIAL_ROUTES.get(target.hostname)?.includes(target.pathname)) {
    throw new Error($t("redeem-preview.http.text_a5c7a696a8"))
  }
  return target
}

export interface OfficialJsonOptions {
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

// Native HTTPS does not use Node's environment proxy dispatcher. Keep this
// fallback scoped to our public official endpoints; never change global routing.
export function requestOfficialJson(url: string | URL, { headers = {}, timeoutMs = 10000, signal }: OfficialJsonOptions = {}): Promise<unknown> {
  const target = officialReadTarget(url)
  const timeout = AbortSignal.timeout(timeoutMs)
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout
  return new Promise((resolve, reject) => {
    const request = https.request(target, { method: "GET", headers: { ...headers, "accept-encoding": "identity" }, signal: deadline }, response => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error($t("redeem-preview.http.text_a7934a720b", { "statusCode": response.statusCode })))
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > officialJsonByteLimit) response.destroy(new Error($t("redeem-preview.http.text_131ede9f29")))
        else chunks.push(chunk)
      })
      response.on("error", reject)
      response.on("aborted", () => reject(new Error($t("redeem-preview.http.text_8f7fb7b501"))))
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))) }
        catch (error) { reject(error) }
      })
    })
    request.on("error", reject)
    request.end()
  })
}
