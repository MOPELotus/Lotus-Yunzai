import { createTranslator as createTextTranslator } from "../../i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import fs from "node:fs/promises"
import { constants } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { REDEEM_GAMES, type RedeemGame, type RedeemGameId } from "./games.ts"
import { MiyoliveProvider, compareVersions, versionOf, plainText, parseExpiry, parseOfficialDate, type PreviewExpiry } from "./official.ts"

import type { RedeemPreviewOptions } from "./index.ts"

interface RedeemCode {
  readonly code: string
  readonly reward: string
}

export interface RedeemPreviewResult {
  readonly game: RedeemGameId
  readonly gameName: string
  readonly checkedAt: number
  readonly codes: readonly RedeemCode[]
  readonly status: "available" | "unreleased" | "expired" | "expiry-unconfirmed" | "unavailable" | "error"
  readonly version?: string
  readonly title?: string
  readonly startAt?: number
  readonly source?: string
  readonly actId?: string
  readonly codeVersion?: string | number
  readonly expiry?: PreviewExpiry | null
  readonly expirySource?: string
  readonly reason?: string
}

type PreviewHistory = Partial<Record<RedeemGameId, string[]>>
const historyGames = REDEEM_GAMES.map(game => game.id)

export class RedeemCodeService {
  readonly now: () => number
  readonly providers: { readonly miyolive: MiyoliveProvider }
  readonly historyFile: string | null
  readonly legacyHistoryFiles: readonly string[]
  history: PreviewHistory | null = null
  legacyHistory: PreviewHistory = {}
  loading: Promise<void> | null = null
  readonly inflight = new Map<RedeemGameId, Promise<RedeemPreviewResult>>()
  persisting = Promise.resolve()
  #historyRevision = 0
  #savedHistoryRevision = 0

  constructor(options: RedeemPreviewOptions = {}) {
    this.now = options.now || Date.now
    this.providers = { miyolive: new MiyoliveProvider(options) }
    this.historyFile = options.historyFile || null
    this.legacyHistoryFiles = [...new Set(options.legacyHistoryFiles || [])].filter(file => file !== this.historyFile)
  }

  async query(gameId: string): Promise<RedeemPreviewResult> {
    const game = REDEEM_GAMES.find(item => item.id === gameId)
    if (!game) throw new Error($t("redeem-preview.service.text_a96bfac325"))
    const active = this.inflight.get(game.id)
    if (active) return active
    const task = this.collect(game).finally(() => this.inflight.delete(game.id))
    this.inflight.set(game.id, task)
    return task
  }

  async collect(game: RedeemGame): Promise<RedeemPreviewResult> {
    const base: Pick<RedeemPreviewResult, "game" | "gameName" | "checkedAt" | "codes"> = {
      game: game.id, gameName: game.name, checkedAt: this.now(), codes: [],
    }
    try {
      await this.loadHistory()
      const provider = this.providers[game.provider]
      if (!provider) throw new Error($t("redeem-preview.service.text_bba8200d55"))
      const remembered = [...new Set([...(this.history?.[game.id] || []), ...(this.legacyHistory[game.id] || [])])].slice(0, 12)
      const found = await provider.discover(game, remembered)
      await this.saveHistory(game.id, found.activities || [])
      const { activity, newestVersion, posts, announcement } = found
      const version = activity ? versionOf(activity.live.title) : ""
      const announcementIsUpcoming = (announcement?.startAt ?? NaN) > this.now()
      if (announcementIsUpcoming && announcement && (!version || compareVersions(newestVersion, version) >= 0)) {
        const start = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(announcement.startAt)
        return { ...base, version: newestVersion, title: announcement.title, status: "unreleased", startAt: announcement.startAt,
          source: `https://www.miyoushe.com/${game.community}/article/${announcement.postId}`, reason: $t("redeem-preview.service.text_d9da937f01", { "start": start }) }
      }
      // Discovering the next preview must invalidate the previous preview immediately,
      // even if its old page and code endpoint are still alive.
      if (activity && newestVersion && (!version || compareVersions(newestVersion, version) > 0)) {
        return { ...base, version: newestVersion, status: "unreleased", title: $t("redeem-preview.service.text_521a32bc59", { "name": game.name, "newestVersion": newestVersion }), reason: $t("redeem-preview.service.text_61a96a0d13") }
      }
      if (!activity) {
        // Expired pages can disappear from navigation and the livestream API.
        // A matching official recap can still give a precise expiry without codes.
        for (const post of posts.filter(p => newestVersion && versionOf(p.subject) === newestVersion).sort((a, b) => Number(b.created_at) - Number(a.created_at))) {
          const expiry = parseExpiry(post.structured_content || post.content, Number(post.created_at) * 1000 || this.now())
          if (expiry && expiry.ms <= this.now()) {
            return { ...base, version: newestVersion, title: $t("redeem-preview.service.text_521a32bc59", { "name": game.name, "newestVersion": newestVersion }), status: "expired", expiry,
              source: `https://www.miyoushe.com/${game.community}/article/${post.post_id}` }
          }
        }
        return { ...base, version: newestVersion, status: "unavailable", reason: $t("redeem-preview.service.text_359268b261") }
      }
      let template: { readonly codeTipText?: unknown } | string = activity.template || {}
      if (typeof template === "string") {
        try { template = JSON.parse(template) as { readonly codeTipText?: unknown } } catch { template = {} }
      }
      const startMs = parseOfficialDate(activity.live.start)
      const reference = startMs || this.now()
      const pageUrl = `https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=${activity.actId}`
      let expiry = parseExpiry(template.codeTipText || "", reference)
      let invalidExpiry = expiry === undefined
      let expirySource = expiry ? pageUrl : ""
      if (!expiry && version) {
        for (const post of posts.filter(p => versionOf(p.subject) === version).sort((a, b) => Number(b.created_at) - Number(a.created_at))) {
          expiry = parseExpiry(post.structured_content || post.content, reference)
          invalidExpiry ||= expiry === undefined
          if (expiry) { expirySource = `https://www.miyoushe.com/${game.community}/article/${post.post_id}`; break }
        }
      }
      const result = { ...base, title: activity.live.title, version, actId: activity.actId, codeVersion: activity.live.code_ver, source: pageUrl, expiry: expiry ?? null, expirySource, startAt: startMs }
      if (startMs > this.now() || Number(activity.live.remain) > 0) return { ...result, status: "unreleased", reason: $t("redeem-preview.service.text_c11f022b8d") }
      if (expiry && expiry.ms <= this.now()) return { ...result, status: "expired" }
      if (!expiry && invalidExpiry) {
        return { ...result, status: "expiry-unconfirmed", reason: $t("redeem-preview.service.text_c2e056c9fa") }
      }
      if (!expiry && game.requireExpiry) {
        const endAt = parseOfficialDate(activity.live.end)
        const reason = $t("redeem-preview.service.text_796fdd946e")
        if (endAt > 0 && endAt <= this.now()) {
          const end = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" }).format(endAt)
          return { ...result, status: "expiry-unconfirmed", reason: $t("redeem-preview.service.text_63da29d5f7", { "end": end, "reason": reason }) }
        }
        return { ...result, status: "expiry-unconfirmed", reason }
      }
      const entries = await provider.codes(activity)
      if (expiry && expiry.ms <= this.now()) return { ...result, status: "expired" }
      const seen = new Set()
      result.codes = entries.filter(item => {
        const code = typeof item?.code === "string" ? item.code.trim() : ""
        if (!code || seen.has(code) || Number(item.to_get_time || 0) * 1000 > this.now()) return false
        seen.add(code)
        return true
      }).map(item => ({ code: String(item.code).trim(), reward: plainText(item.title) }))
      return { ...result, status: result.codes.length ? "available" : "unreleased", reason: result.codes.length ? "" : $t("redeem-preview.service.text_19d5ed5edd") }
    } catch (error) {
      return { ...base, status: "error", reason: error instanceof Error ? error.message : $t("redeem-preview.service.text_b43efd3db4") }
    }
  }

  async loadHistory() {
    if (this.history) return
    if (!this.loading) this.loading = this.readHistory()
    await this.loading
  }

  async readHistory() {
    const [current = {}, ...past] = await Promise.all([this.historyFile, ...this.legacyHistoryFiles].map(file => this.readHistoryFile(file)))
    this.legacyHistory = Object.fromEntries(historyGames.map(id => [id,
      [...new Set(past.flatMap(history => history[id] || []))].slice(0, 12),
    ]))
    this.history = current
  }

  async readHistoryFile(historyFile: string | null): Promise<PreviewHistory> {
    if (!historyFile) return {}
    try {
      const file = await fs.open(historyFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let parsed: Partial<Record<RedeemGameId, unknown[]>> | null
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > 32 * 1024) throw new Error($t("redeem-preview.service.text_cfdabe5eca"))
        parsed = JSON.parse(await file.readFile("utf8")) as Partial<Record<RedeemGameId, unknown[]>> | null
      } finally {
        await file.close()
      }
      return Object.fromEntries(historyGames.filter(id => Array.isArray(parsed?.[id])).map(id => [id,
        parsed![id]!.filter(value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value)).slice(0, 12),
      ]))
    } catch {
      return {}
    }
  }

  async saveHistory(gameId: RedeemGameId, activities: readonly string[]) {
    const history = this.history!
    const previous = history[gameId] || []
    const next = [...new Set([...activities, ...previous])].slice(0, 12)
    if (previous.length !== next.length || previous.some((id, index) => id !== next[index])) {
      history[gameId] = next
      this.#historyRevision++
    }
    const file = this.historyFile
    if (!file || this.#historyRevision === this.#savedHistoryRevision) return
    this.persisting = this.persisting.then(async () => {
      const revision = this.#historyRevision
      if (revision === this.#savedHistoryRevision) return
      const contents = JSON.stringify(history)
      await fs.mkdir(path.dirname(file), { recursive: true })
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, contents, { encoding: "utf8", flag: "wx" })
        await fs.rename(temporary, file)
        this.#savedHistoryRevision = revision
      } finally {
        await fs.rm(temporary, { force: true })
      }
    }).catch(() => {
      // Keep discovered IDs available to concurrent queries and retry the unsaved version later.
    })
    await this.persisting
  }
}

export function formatRedeemResult(result: RedeemPreviewResult) {
  const title = result.title || $t("redeem-preview.service.text_a9a43c79eb", { "gameName": result.gameName })
  if (result.status === "error") return $t("redeem-preview.service.text_68077b9caf", { "title": title, "reason": result.reason })
  if (result.status === "unavailable") return $t("redeem-preview.service.text_4827648c81", { "title": title, "reason": result.reason })
  const lines = [title]
  if (result.status === "expired") lines.push($t("redeem-preview.service.text_0aaab819f2"))
  else if (result.status === "expiry-unconfirmed") lines.push(result.reason!)
  else if (result.status === "unreleased") lines.push(result.reason || $t("redeem-preview.service.text_76e449bc9c"))
  else for (const item of result.codes) lines.push("", item.code, ...(item.reward ? [item.reward] : []))
  if (result.expiry) lines.push("", $t("redeem-preview.service.text_8ffe9af59e", { "text": result.expiry.text }))
  else if (result.status === "available") lines.push("", $t("redeem-preview.service.text_2a6e10e892"))
  if (result.source) lines.push($t("redeem-preview.service.text_9f92adbb68", { "source": result.source }))
  if (result.expirySource && result.expirySource !== result.source) lines.push($t("redeem-preview.service.text_3298b9735c", { "expirySource": result.expirySource }))
  return lines.join("\n")
}
