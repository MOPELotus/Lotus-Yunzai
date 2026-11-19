export const REDEEM_GAMES = Object.freeze([
  { id: "gs", name: "原神", aliases: ["原神"], community: "ys", gids: 2, uid: "75276539", provider: "miyolive" },
])

export function parseRedeemCommand(message) {
  let text = String(message || "").trim()
  if (!/(?:兑换码|code)$/i.test(text)) return null
  const prefix = /^[#*%％/]/.test(text) ? text[0] : ""
  if (prefix) text = text.slice(1)
  text = text.replace(/(?:直播|前瞻)?(?:兑换码|code)$/i, "")
  if (text) return REDEEM_GAMES.find(game => game.aliases.some(alias => alias.toLowerCase() === text.toLowerCase())) || null
  if (prefix === "*" || prefix === "%" || prefix === "％") return null
  return REDEEM_GAMES[0]
}
