import { segment, type GroupNotice, type MessageEvent } from "../messages.ts";
import { authorized } from "../server.ts";
import { OneBotCalls } from "./onebot-calls.ts";
import { decodeOneBotMessage, encodeOneBotReply } from "./onebot-message.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function dispatchGroupNotice(
  dispatch: (event: GroupNotice) => Promise<void>,
  send: (message: string) => boolean,
  event: Record<string, unknown>,
  calls: OneBotCalls,
  isMaster: (bot: number, user: number) => boolean,
): Promise<void> {
  const { notice_type, user_id, group_id, self_id, operator_id } = event;
  if (notice_type !== "group_increase" && notice_type !== "group_decrease") return;
  if (!isId(user_id) || !isId(group_id) || !isId(self_id)) return;

  const sub_type = notice_type === "group_increase" ? "increase" : "decrease";
  const action = stringField(event.sub_type);
  const member = isRecord(event.member) ? event.member : undefined;
  await dispatch({
    post_type: "notice",
    notice_type: "group",
    sub_type,
    action_sub_type: action,
    increase_type: sub_type === "increase" ? action : undefined,
    decrease_type: sub_type === "decrease" ? action : undefined,
    inviter_id: sub_type === "increase" && action === "invite" && isId(operator_id) ? operator_id : undefined,
    user_id, group_id, self_id,
    operator_id: isId(operator_id) ? operator_id : undefined,
    group_name: stringField(event.group_name),
    nickname: stringField(event.nickname),
    member: member && { card: stringField(member.card), nickname: stringField(member.nickname) },
    dismiss: typeof event.dismiss === "boolean" ? event.dismiss : undefined,
    isGroup: true,
    isPrivate: false,
    isMaster: isId(operator_id) && isMaster(self_id, operator_id),
    reply(reply) {
      const message = encodeOneBotReply(reply);
      if (message === undefined) return false;
      return calls.replyWithConfirmation(send, { message_type: "group", group_id, message, auto_escape: true });
    },
  });
}

async function dispatchMessage(
  dispatch: (event: MessageEvent) => Promise<void>,
  send: (message: string) => boolean,
  event: Record<string, unknown>,
  calls: OneBotCalls,
  isMaster: (bot: number, user: number) => boolean,
): Promise<void> {
  const userId = event.user_id;
  if (event.post_type !== "message" || !isId(userId) || userId === event.self_id) return;

  let target: { user_id: number } | { group_id: number };
  if (event.message_type === "private") {
    target = { user_id: userId };
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
    user_id: userId,
    group_id: "group_id" in target ? target.group_id : undefined,
    sender,
    member: messageType === "group" ? {
      is_admin: sender?.role === "admin",
      is_owner: sender?.role === "owner",
    } : undefined,
    isGroup: messageType === "group",
    isPrivate: messageType === "private",
    isMaster: selfId !== undefined && isMaster(selfId, userId),
    likeSelf: (count) => calls.likeSelf(send, userId, count),
    isFriend: () => messageType === "private" && event.sub_type === "friend"
      ? Promise.resolve(true) : calls.isFriend(send, userId),
    reply(reply, quote = false, options = {}) {
      const mention = options.at === true ? userId : options.at;
      const body = messageType === "group" && (isId(mention) || typeof mention === "string" && /^([1-9]\d*|all)$/u.test(mention))
        ? [segment.at(mention), "\n", ...(Array.isArray(reply) ? reply : [reply])] : reply;
      const message = encodeOneBotReply(body, quote ? messageId : undefined);
      if (message === undefined) return false;

      const params = { message_type: messageType, ...target, message, auto_escape: true };
      const seconds = options.recallMsg;
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && seconds <= 120) {
        return calls.replyWithRecall(send, params, seconds, messageId);
      }
      return send(JSON.stringify({ action: "send_msg", params }));
    },
  });
}

export function startOneBot(
  dispatch: (event: MessageEvent | GroupNotice) => Promise<void>,
  options: {
    hostname: string;
    port: number;
    auth: Headers;
    isMaster: (bot: number, user: number) => boolean;
    http?: (request: Request) => Response;
  },
) {
  return Bun.serve<OneBotCalls>({
    hostname: options.hostname,
    port: options.port,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path !== "/OneBotv11" && path !== "/OneBotv11/") {
        return options.http?.(request) ?? new Response(null, { status: 404 });
      }
      if (!authorized(request, options.auth)) {
        return new Response(null, { status: 401 });
      }
      if (request.headers.get("X-Client-Role")?.toLowerCase() !== "universal") {
        return new Response("需要 OneBot 11 Universal 连接。", { status: 400 });
      }
      if (!server.upgrade(request, { data: new OneBotCalls() })) {
        return new Response(null, { status: 426 });
      }
    },
    websocket: {
      async message(socket, input) {
        if (typeof input !== "string") return;
        let message: unknown;
        try {
          message = JSON.parse(input);
        } catch {
          return;
        }
        if (!isRecord(message) || socket.data.receive(message)) return;

        try {
          const send = (output: string) => socket.readyState === WebSocket.OPEN && socket.send(output) !== 0;
          if (message.post_type === "notice") {
            await dispatchGroupNotice(dispatch, send, message, socket.data, options.isMaster);
          } else {
            await dispatchMessage(dispatch, send, message, socket.data, options.isMaster);
          }
        } catch {
          console.error("处理 OneBot 事件失败。");
        }
      },
      close(socket) {
        socket.data.close();
      },
    },
  });
}
