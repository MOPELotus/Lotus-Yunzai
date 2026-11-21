export type RedeemGameId = "gs" | "sr" | "zzz" | "bh3"

export interface RedeemGame {
  readonly id: RedeemGameId
  readonly name: string
  readonly aliases: readonly string[]
  readonly prefix: readonly string[]
  readonly community: string
  readonly gids: number
  readonly uid: string
  readonly provider: "miyolive"
  readonly postPattern?: RegExp
  readonly searchKeyword?: string
  readonly requireExpiry?: boolean
}

export const REDEEM_GAMES = Object.freeze<readonly [RedeemGame, ...RedeemGame[]]>([
  { id: "gs", name: "原神", aliases: ["原神"], prefix: ["#"], community: "ys", gids: 2, uid: "75276539", provider: "miyolive" },
  { id: "sr", name: "星穹铁道", aliases: ["星铁", "崩铁", "星穹铁道", "崩坏星穹铁道", "崩坏：星穹铁道"], prefix: ["*"], community: "sr", gids: 6, uid: "288909600", provider: "miyolive" },
  { id: "zzz", name: "绝区零", aliases: ["绝区零", "绝区", "zzz"], prefix: ["%", "％"], community: "zzz", gids: 8, uid: "152039148", provider: "miyolive" },
  { id: "bh3", name: "崩坏3", aliases: ["崩三", "崩坏三", "崩坏3"], prefix: [], community: "bh3", gids: 1, uid: "73565430",
    provider: "miyolive", postPattern: /特别节目|直播兑换码/, searchKeyword: "前瞻 特别节目", requireExpiry: true },
])

export function parseRedeemCommand(message: unknown): RedeemGame | null {
  let text = String(message || "").trim()
  if (!/(?:兑换码|code)$/i.test(text)) return null
  const prefix = /^[#*%％/]/.test(text) ? text[0]! : ""
  if (prefix) text = text.slice(1)
  text = text.replace(/(?:直播|前瞻)?(?:兑换码|code)$/i, "")
  if (text) return REDEEM_GAMES.find(game => game.aliases.some(alias => alias.toLowerCase() === text.toLowerCase())) || null
  return REDEEM_GAMES.find(game => game.prefix.includes(prefix)) || REDEEM_GAMES[0]
}
