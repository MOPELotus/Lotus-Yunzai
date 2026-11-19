const forwards = new WeakSet()

/**
 * @param {unknown} _event
 * @param {import("../messages.ts").MessageReply | readonly import("../messages.ts").MessageReply[]} [message]
 * @param {import("../messages.ts").MessageReply} [description]
 * @returns {import("../commands.ts").CommandForward}
 */
export function makeForwardMsg(_event, message = [], description) {
  const nodes = Array.isArray(message) ? [...message] : [message]
  if (description) nodes.unshift(description)
  const forward = { type: "forward", nodes }
  forwards.add(forward)
  return forward
}

/**
 * @param {unknown} input
 * @returns {input is import("../commands.ts").CommandForward}
 */
export function isLegacyForward(input) {
  return !!input && typeof input === "object" && forwards.has(input)
}

export default Object.freeze({ makeForwardMsg })
