import type { MessageEvent } from "../messages.ts";
import { decodeOneBotMessage, encodeOneBotReply } from "./onebot-message.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function dispatchMessage(
  dispatch: (event: MessageEvent) => Promise<void>,
  send: (message: string) => boolean,
  input: string,
): Promise<void> {
  let event: unknown;
  try {
    event = JSON.parse(input);
  } catch {
    return;
  }

  if (!isRecord(event) || event.post_type !== "message" ||
      !isId(event.user_id) || event.user_id === event.self_id) {
    return;
  }

  let target: { user_id: number } | { group_id: number };
  if (event.message_type === "private") {
    target = { user_id: event.user_id };
  } else if (event.message_type === "group" && isId(event.group_id)) {
    target = { group_id: event.group_id };
  } else {
    return;
  }

  const selfId = isId(event.self_id) ? event.self_id : undefined;
  const incoming = decodeOneBotMessage(event.message, selfId);
  if (incoming === undefined) return;
  const { text, ...messageFields } = incoming;

  const messageType = event.message_type;
  const messageId = typeof event.message_id === "number" && Number.isSafeInteger(event.message_id)
    ? event.message_id : undefined;
  const sender = isRecord(event.sender) ? event.sender : undefined;
  await dispatch({
    msg: text.trim(),
    raw_message: typeof event.raw_message === "string" ? event.raw_message : text,
    ...messageFields,
    post_type: "message",
    message_type: messageType,
    sub_type: typeof event.sub_type === "string" ? event.sub_type : undefined,
    message_id: messageId,
    self_id: selfId,
    user_id: event.user_id,
    group_id: "group_id" in target ? target.group_id : undefined,
    sender,
    member: messageType === "group" ? {
      is_admin: sender?.role === "admin",
      is_owner: sender?.role === "owner",
    } : undefined,
    isGroup: messageType === "group",
    isPrivate: messageType === "private",
    isMaster: false,
    reply(reply, quote = false) {
      const message = encodeOneBotReply(reply, quote ? messageId : undefined);
      if (message === undefined) return false;
      return send(JSON.stringify({
        action: "send_msg",
        params: { message_type: messageType, ...target, message, auto_escape: true },
      }));
    },
  });
}

export function startOneBot(dispatch: (event: MessageEvent) => Promise<void>, token: string, port: number) {
  if (!token.trim()) {
    throw new Error("LOTUS_ONEBOT_TOKEN 不能为空。");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("LOTUS_ONEBOT_PORT 必须是 0 到 65535 之间的整数。");
  }

  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request, server) {
      if (new URL(request.url).pathname !== "/OneBotv11") {
        return new Response(null, { status: 404 });
      }
      if (request.headers.get("Authorization") !== `Bearer ${token}`) {
        return new Response(null, { status: 401 });
      }
      if (request.headers.get("X-Client-Role")?.toLowerCase() !== "universal") {
        return new Response("需要 OneBot 11 Universal 连接。", { status: 400 });
      }
      if (!server.upgrade(request)) {
        return new Response(null, { status: 426 });
      }
    },
    websocket: {
      async message(socket, input) {
        if (typeof input !== "string") {
          return;
        }
        try {
          await dispatchMessage(dispatch, (message) =>
            socket.readyState === WebSocket.OPEN && socket.send(message) !== 0, input);
        } catch {
          console.error("处理 OneBot 消息失败。");
        }
      },
    },
  });
}
