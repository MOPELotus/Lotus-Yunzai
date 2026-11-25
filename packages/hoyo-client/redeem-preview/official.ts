import { createTranslator as createTextTranslator } from "../../i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
// Public official APIs only. No account cookie or redemption API is needed.
import { officialJsonByteLimit, officialReadTarget, requestOfficialJson, type OfficialJsonOptions } from "./http.ts"
import { setTimeout as delay } from "node:timers/promises"
import { readGameRecordPayload } from "../game-record.ts"
import type { RedeemGame } from "./games.ts"
import type { RedeemPreviewOptions } from "./index.ts"

type DirectRequestOptions = Required<Pick<OfficialJsonOptions, "headers" | "timeoutMs">> & Pick<OfficialJsonOptions, "signal">
type DirectRequest = (url: string, options: DirectRequestOptions) => Promise<unknown>
type ProviderOptions = Pick<RedeemPreviewOptions, "fetch" | "now" | "signal"> & {
  readonly directRequest?: DirectRequest | false
}

export interface PreviewExpiry {
  readonly ms: number
  readonly text: string
}

interface OfficialPost {
  readonly post_id: string | number
  readonly uid?: string | number
  readonly subject: string
  readonly created_at: string | number
  readonly structured_content?: unknown
  readonly content?: unknown
}

type PostEnvelope = OfficialPost & { readonly post?: PostEnvelope }
interface PostPage {
  readonly list?: readonly unknown[]
  readonly posts?: readonly unknown[]
  readonly is_last?: boolean
  readonly next_offset?: string | number
}

interface LiveIndex {
  readonly streamer?: { readonly aid?: string | number }
  readonly live: {
    readonly title: string
    readonly start?: string
    readonly end?: string
    readonly remain?: string | number
    readonly code_ver?: string | number
  }
  readonly template?: string | { readonly codeTipText?: unknown } | null
}

interface LiveActivity extends LiveIndex {
  readonly actId: string
}

interface OfficialCode {
  readonly code?: unknown
  readonly title?: unknown
  readonly to_get_time?: string | number
}

interface PreviewAnnouncement {
  readonly startAt: number
  readonly postId: string
  readonly title: string
}

interface Discovery {
  readonly activity: LiveActivity | null
  readonly posts: readonly OfficialPost[]
  readonly newestVersion: string
  readonly activities: readonly string[]
  readonly announcement: PreviewAnnouncement | null
}

interface RequestFailure {
  readonly cause?: { readonly code?: string }
  readonly code?: string
  readonly message?: string
  readonly retryable?: boolean
}


const BBS = "https://bbs-api.mihoyo.com"
const LIVE = "https://api-takumi.mihoyo.com/event/miyolive"
const LIVE_STATIC = "https://api-takumi-static.mihoyo.com/event/miyolive"

export function versionOf(text: unknown) {
  return String(text || "").match(/(?:[vV]\s*)?(\d+\.\d+)\s*(?:版本|更新|前瞻|特别节目|「[^」]+」\s*(?:前瞻|特别节目))/)?.[1] || ""
}

export function compareVersions(a: string, b: string) {
  const aa = a.split(".").map(Number), bb = b.split(".").map(Number)
  return (aa[0]! - bb[0]!) || (aa[1]! - bb[1]!)
}

export function plainText(value: unknown) {
  const raw = String(value || "")
  try {
    const flatten = (x: unknown): string => typeof x === "string" ? x : Array.isArray(x) ? x.map(flatten).join("")
      : x && typeof x === "object" ? Object.values(x).map(flatten).join("") : ""
    return stripHtml(flatten(JSON.parse(raw)))
  } catch { return stripHtml(raw) }
}

function stripHtml(text: string) {
  return text.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&times;/g, "×")
}

// to_get_time is the release time; never use it to guess an expiry.
// null means no dated deadline was published; undefined means the dated claim did not validate.
export function parseExpiry(text: unknown, referenceMs: number): PreviewExpiry | null | undefined {
  const datePattern = /(?:(\d{4})\s*[年\-/]\s*)?(\d{1,2})\s*[月\-/]\s*(\d{1,2})\s*日?\s*(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*(?:[:：分]\s*(\d{1,2})\s*秒?)?/g
  let invalid = false
  // Scope to sentences mentioning codes and expiry, to exclude launch and broadcast dates.
  for (const sentence of plainText(text).split(/[\n。！？]/)) {
    if (!/兑换码/.test(sentence) || !/失效|过期|截止|有效期|有效至|有效时间/.test(sentence)) continue
    // If an official validity range is given, its last date is the deadline.
    const match = [...sentence.matchAll(datePattern)].at(-1)
    if (!match) continue
    const reference = new Date(referenceMs + 8 * 3600000)
    let year = Number(match[1] || reference.getUTCFullYear())
    const month = Number(match[2]), day = Number(match[3]), hour = Number(match[4])
    const minute = Number(match[5] || 0), second = Number(match[6] || 0)
    if (!match[1] && reference.getUTCMonth() === 11 && month === 1) year++
    const ms = Date.UTC(year, month - 1, day, hour - 8, minute, second)
    const check = new Date(ms + 8 * 3600000)
    if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day ||
        hour > 23 || minute > 59 || second > 59) {
      invalid = true
      continue
    }
    return { ms, text: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}` }
  }
  return invalid ? undefined : null
}

export function previewAnnouncement(posts: readonly OfficialPost[], newestVersion: string, includeUnversioned = false): PreviewAnnouncement | null {
  for (const post of [...posts].sort((a, b) => Number(b.created_at) - Number(a.created_at))) {
    const version = versionOf(post.subject)
    if ((version !== newestVersion && !(includeUnversioned && !version)) || !/前瞻|特别节目/.test(post.subject)) continue
    const reference = Number(post.created_at) * 1000
    if (!Number.isFinite(reference) || reference <= 0) continue
    const text = plainText(post.structured_content || post.content)
    const match = text.match(/(?:前瞻|特别节目)[^。！？\n]{0,35}?将于\s*(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(?:[（(][^）)\n]{0,12}[）)])?\s*(晚(?:上)?)?\s*(\d{1,2})[:：](\d{2})(?:[^。！？\n]{0,20}?)(?:播出|开播|开启|首播)/)
    if (!match) continue
    const [, explicitYear, monthText, dayText, evening, hourText, minuteText] = match
    const month = Number(monthText), day = Number(dayText)
    const clockHour = Number(hourText), minute = Number(minuteText)
    const hour = evening && clockHour > 0 && clockHour < 12 ? clockHour + 12 : clockHour
    const published = new Date(reference + 8 * 3600_000)
    const year = Number(explicitYear || (published.getUTCFullYear() + Number(published.getUTCMonth() === 11 && month === 1)))
    const startAt = Date.UTC(year, month - 1, day, hour - 8, minute)
    const normalized = new Date(startAt + 8 * 3600_000)
    if (month < 1 || month > 12 || day !== normalized.getUTCDate() || hour > 23 || minute > 59
      || startAt < reference || startAt - reference > 45 * 86400_000) continue
    return { startAt, postId: String(post.post_id), title: post.subject }
  }
  return null
}

export function activityIds(value: unknown): string[] {
  // Structured posts contain JSON-escaped links. Restrict to official livestream pages.
  const raw = JSON.stringify(value)!.replace(/\\+u0026/gi, "&").replace(/\\+u003d/gi, "=").replace(/\\+/g, "").replace(/&amp;/g, "&")
  return [...raw.matchAll(/https:\/\/(?:webstatic\.mihoyo\.com\/bbs\/event\/live\/index\.html|act\.mihoyo\.com\/[^"\s?]*live[^"\s?]*)\?(?:[^"\s]*?&)?act_id=([a-zA-Z0-9_-]{1,80})(?=&|["#\s]|$)/g)].map(m => m[1]!)
}

function normalizePost(item: unknown): OfficialPost | null {
  const row = item as PostEnvelope | undefined
  const post = row?.post?.post || row?.post || row
  return post && (typeof post.post_id === "string" ||
    (typeof post.post_id === "number" && Number.isSafeInteger(post.post_id))) &&
    /^[1-9]\d{0,23}$/.test(String(post.post_id)) && typeof post.subject === "string" ? post : null
}

function checkedLists<T extends object>(data: T | null, ...fields: (keyof T)[]): T {
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      fields.some(field => data[field] != null && !Array.isArray(data[field]))) {
    throw new Error($t("redeem-preview.official.text_8be5f4f843"))
  }
  return data
}

export class MiyoliveProvider {
  readonly fetch: NonNullable<ProviderOptions["fetch"]>
  readonly now: () => number
  readonly signal?: AbortSignal
  readonly directRequest: DirectRequest | null

  constructor(options: ProviderOptions = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.now = options.now || Date.now
    this.signal = options.signal
    this.directRequest = options.directRequest === false ? null : options.directRequest || (options.fetch ? null : requestOfficialJson)
  }

  async request<T = unknown>(url: string, actId = ""): Promise<T | null> {
    this.signal?.throwIfAborted()
    const target = officialReadTarget(url)
    const deadline = Date.now() + 20000
    const headers = { "x-rpc-client_type": "2", "x-rpc-act_id": actId, Referer: "https://www.miyoushe.com/" }
    let body: unknown
    let liveIndexGone = false
    try {
      let response!: Response
      let requestSignal!: AbortSignal
      for (const waitMs of [0, 800, 1800]) {
        if (waitMs) await delay(waitMs, undefined, { signal: this.signal })
        const timeout = AbortSignal.timeout(Math.min(10000, Math.max(1, deadline - Date.now())))
        requestSignal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout
        response = await this.fetch(target.href, { method: "GET", credentials: "omit", redirect: "error",
          headers, signal: requestSignal })
        if (response.redirected || (response.url && response.url !== target.href)) {
          await response.body?.cancel().catch(() => undefined)
          throw Object.assign(new Error($t("redeem-preview.official.text_b8c6a61c9f")), { retryable: false })
        }
        if (response.status !== 403 || waitMs === 1800 || deadline - Date.now() < 3000) break
        await response.body?.cancel().catch(() => {})
      }
      if (!response.ok) {
        liveIndexGone = response.status === 410 && target.hostname === "api-takumi.mihoyo.com" &&
          target.pathname === "/event/miyolive/index"
        const error = Object.assign(new Error($t("redeem-preview.official.text_1cf0e42297", { "status": response.status })), {
          retryable: response.status >= 500 || response.status === 429 || liveIndexGone,
          httpStatus: response.status,
        })
        await response.body?.cancel().catch(() => {})
        throw error
      }
      body = await readGameRecordPayload(response, officialJsonByteLimit, requestSignal)
      requestSignal.throwIfAborted()
      if (!body) throw new Error($t("redeem-preview.official.text_e322210fc6"))
    } catch (error) {
      this.signal?.throwIfAborted()
      const endpoint = `${target.hostname}${target.pathname}`
      const failure = error as RequestFailure
      const detail = failure.cause?.code || failure.code || failure.message
      if (!this.directRequest || failure.retryable === false) throw new Error(`${endpoint}：${detail}`, { cause: error })
      let lastError: RequestFailure | null | undefined
      for (const waitMs of liveIndexGone ? [0] : [0, 150, 350]) {
        if (waitMs) await delay(waitMs, undefined, { signal: this.signal })
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) break
        try {
          body = await this.directRequest(target.href, { headers, timeoutMs: Math.min(10000, remainingMs), signal: this.signal })
          lastError = null
          break
        } catch (retryError) {
          this.signal?.throwIfAborted()
          lastError = retryError as RequestFailure
        }
      }
      if (!body) throw new Error($t("redeem-preview.official.text_03eaaa1efb", { "endpoint": endpoint, "detail": detail, "value3": lastError?.code || lastError?.message || $t("redeem-preview.official.text_e512cf016f") }), { cause: lastError || error })
    }
    const envelope = body as { readonly retcode?: number; readonly data?: T } | null | undefined
    const code = envelope?.retcode
    if ((code === -500007 || code === -500012) && target.pathname === "/event/miyolive/index") return null
    if (code !== 0 || !envelope?.data) throw new Error($t("redeem-preview.official.text_1c9cc227ad", { "value1": code ?? $t("redeem-preview.official.text_6f83a34202") }))
    return envelope.data
  }

  async discover(game: RedeemGame, remembered: readonly string[] = []): Promise<Discovery> {
    const [homeResult, postsResult] = await Promise.allSettled([
      this.request<{ readonly navigator?: readonly ({ readonly name?: string } | null)[] }>(`https://bbs-api.miyoushe.com/apihub/api/home/new?gids=${game.gids}&parts=1%2C3%2C4`)
        .then(data => checkedLists(data, "navigator")),
      this.request<PostPage>(`${BBS}/post/wapi/userPost?uid=${game.uid}&size=50&offset=0`)
        .then(data => checkedLists(data, "list")),
    ])
    const errors = [homeResult, postsResult].filter(r => r.status === "rejected").map(r => (r.reason as RequestFailure).message)
    const ids = new Set<string>()
    const navigationIds = new Set<string>()
    if (homeResult.status === "fulfilled") {
      for (const nav of homeResult.value.navigator || []) {
        if (typeof nav?.name === "string" && /前瞻|特别节目|直播|兑换码/.test(nav.name)) {
          activityIds(nav).forEach(id => { ids.add(id); navigationIds.add(id) })
        }
      }
    }
    const posts: OfficialPost[] = []
    const addPosts = (list?: readonly unknown[]) => {
      for (const item of list || []) {
        const post = normalizePost(item)
        if (!post || String(post.uid) !== game.uid || !(game.postPattern || /前瞻|特别节目|直播|兑换码/).test(post.subject || "")) continue
        if (!posts.some(p => String(p.post_id) === String(post.post_id))) posts.push(post)
        activityIds(post).forEach(id => ids.add(id))
      }
    }
    if (postsResult.status === "fulfilled") {
      let page = postsResult.value
      addPosts(page.list)
      // Official accounts can publish many posts between livestreams.
      for (let i = 0; i < 2 && !page.is_last && page.next_offset && !posts.some(p => versionOf(p.subject)); i++) {
        try {
          page = checkedLists(await this.request<PostPage>(`${BBS}/post/wapi/userPost?uid=${game.uid}&size=50&offset=${encodeURIComponent(page.next_offset)}`), "list")
          addPosts(page.list)
        } catch (error) { errors.push((error as RequestFailure).message); break }
      }
    }
    // Search only the official author's results. This also recovers older preview links
    // after the homepage entry disappears, without trusting community reposts.
    if (!ids.size && (posts.length || game.searchKeyword)) {
      const version = posts.map(p => versionOf(p.subject)).filter(Boolean).sort(compareVersions).at(-1)
      const keyword = game.searchKeyword || (version && $t("redeem-preview.official.text_08d0d3b14d", { "version": version }))
      if (keyword) {
        try {
          const search = checkedLists(await this.request<PostPage>(`${BBS}/post/wapi/searchPosts?gids=${game.gids}&keyword=${encodeURIComponent(keyword)}&size=20&page=1&sort_type=1`), "posts", "list")
          addPosts(search.posts || search.list)
        } catch (error) { errors.push((error as RequestFailure).message) }
      }
    }
    // A post's full structured content sometimes contains links omitted in the list.
    const newestVersion = posts.map(p => versionOf(p.subject)).filter(Boolean).sort(compareVersions).at(-1) || ""
    const relevant = posts.filter(p => {
      const version = versionOf(p.subject)
      return (newestVersion && version === newestVersion) || (game.searchKeyword && !version && /特别节目/.test(p.subject))
    }).sort((a, b) => Number(b.created_at) - Number(a.created_at)).slice(0, 5)
    const details = await Promise.allSettled(relevant.map(p => this.request<{ readonly post?: unknown }>(`${BBS}/post/wapi/getPostFull?post_id=${p.post_id}&gids=${game.gids}&read=0`)))
    for (const [index, result] of details.entries()) {
      if (result.status !== "fulfilled") continue
      const post = normalizePost(result.value?.post)
      if (post && String(post.uid) === game.uid && String(post.post_id) === String(relevant[index]?.post_id)) {
        const i = posts.findIndex(p => String(p.post_id) === String(post.post_id))
        if (i >= 0) posts[i] = post
        activityIds(post).forEach(id => ids.add(id))
      }
    }
    const announcement = previewAnnouncement(posts, newestVersion, Boolean(game.searchKeyword))
    // On discovery failures, do not present an old remembered activity as current.
    if (homeResult.status === "rejected" || postsResult.status === "rejected") {
      if ((announcement?.startAt ?? NaN) > this.now()) return { activity: null, posts, newestVersion, activities: [], announcement }
      throw new Error($t("redeem-preview.official.text_b1978d89b1", { "value1": errors.join("；") }))
    }
    const candidates = [...new Set([...ids, ...remembered])].slice(0, 12)
    const indexes = await Promise.allSettled(candidates.map(async actId => {
      const data = await this.request<LiveIndex>(`${LIVE}/index`, actId)
      if (String(data?.streamer?.aid) !== game.uid || !data?.live) return null
      return { ...data, actId }
    }))
    if (candidates.some((id, i) => navigationIds.has(id) && indexes[i]!.status === "rejected")) {
      if ((announcement?.startAt ?? NaN) > this.now()) return { activity: null, posts, newestVersion, activities: [], announcement }
      throw new Error($t("redeem-preview.official.text_6916a57e6e"))
    }
    const activities = indexes.flatMap(result => result.status === "fulfilled" && result.value ? [result.value] : [])
      .sort((a, b) => parseOfficialDate(b.live.start) - parseOfficialDate(a.live.start))
    const activity = activities[0]
    if (!activity) {
      if (candidates.length && indexes.some(r => r.status === "rejected") && !((announcement?.startAt ?? NaN) > this.now())) throw new Error($t("redeem-preview.official.text_6916a57e6e"))
      return { activity: null, posts, newestVersion, activities: [], announcement }
    }
    return { activity, posts, newestVersion, activities: activities.map(a => a.actId), announcement }
  }

  async codes(activity: LiveActivity): Promise<OfficialCode[]> {
    if (!activity.live.code_ver) return []
    const data = (await this.request<{ readonly code_list?: OfficialCode[] }>(`${LIVE_STATIC}/refreshCode?version=${encodeURIComponent(activity.live.code_ver)}&time=${Math.floor(this.now() / 1000)}`, activity.actId))!
    if (!Array.isArray(data.code_list)) throw new Error($t("redeem-preview.official.text_665d0143ee"))
    return data.code_list
  }
}

export function parseOfficialDate(value: unknown) {
  if (typeof value !== "string") return 0
  const parts = /^(\d{4})-(\d{2})-(\d{2})[ T]([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/.exec(value)
  if (!parts) return 0
  const ms = Date.parse(value.replace(" ", "T") + "+08:00")
  if (!Number.isFinite(ms)) return 0
  const local = new Date(ms + 8 * 3_600_000)
  if (local.getUTCMonth() + 1 !== Number(parts[2]) || local.getUTCDate() !== Number(parts[3])) return 0
  return ms
}
