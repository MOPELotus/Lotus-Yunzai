import { createTranslator as createTextTranslator } from "../../i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
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
  { id: "gs", name: $t("redeem-preview.games.text_d1597c51ed"), aliases: [$t("redeem-preview.games.text_d1597c51ed")], prefix: ["#"], community: "ys", gids: 2, uid: "75276539", provider: "miyolive" },
  { id: "sr", name: $t("redeem-preview.games.text_4548f2ad35"), aliases: [$t("redeem-preview.games.text_a2927891f0"), $t("redeem-preview.games.text_46f6225ff5"), $t("redeem-preview.games.text_4548f2ad35"), $t("redeem-preview.games.text_8b0c294909"), $t("redeem-preview.games.text_8cfc959b53")], prefix: ["*"], community: "sr", gids: 6, uid: "288909600", provider: "miyolive" },
  { id: "zzz", name: $t("redeem-preview.games.text_b1110352c9"), aliases: [$t("redeem-preview.games.text_b1110352c9"), $t("redeem-preview.games.text_95cec3b66b"), "zzz"], prefix: ["%", "％"], community: "zzz", gids: 8, uid: "152039148", provider: "miyolive" },
  { id: "bh3", name: $t("redeem-preview.games.text_6d3d8653d7"), aliases: [$t("redeem-preview.games.text_df43f0569d"), $t("redeem-preview.games.text_e3173a70bd"), $t("redeem-preview.games.text_6d3d8653d7")], prefix: [], community: "bh3", gids: 1, uid: "73565430",
    provider: "miyolive", postPattern: /特别节目|直播兑换码/, searchKeyword: $t("redeem-preview.games.text_6e7dbd669b"), requireExpiry: true },
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
