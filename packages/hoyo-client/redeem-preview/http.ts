import https from "node:https"

const BBS_PATHS = ["/apihub/api/home/new", "/post/wapi/userPost", "/post/wapi/searchPosts", "/post/wapi/getPostFull"]
const OFFICIAL_ROUTES = new Map([
  ["bbs-api.mihoyo.com", BBS_PATHS],
  ["bbs-api.miyoushe.com", BBS_PATHS],
  ["api-takumi.mihoyo.com", ["/event/miyolive/index"]],
  ["api-takumi-static.mihoyo.com", ["/event/miyolive/refreshCode"]],
])

export function officialReadTarget(url: string | URL) {
  const target = new URL(url)
  if (target.protocol !== "https:" || target.username || target.password || target.port
      || !OFFICIAL_ROUTES.get(target.hostname)?.includes(target.pathname)) {
    throw new Error("不支持的官方查询地址")
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
        reject(new Error(`官方接口 HTTP ${response.statusCode}`))
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 4 * 1024 * 1024) response.destroy(new Error("官方接口响应过大"))
        else chunks.push(chunk)
      })
      response.on("error", reject)
      response.on("aborted", () => reject(new Error("官方接口响应中断")))
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))) }
        catch (error) { reject(error) }
      })
    })
    request.on("error", reject)
    request.end()
  })
}
