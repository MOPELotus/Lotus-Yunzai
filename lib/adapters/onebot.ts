import { segment, type BotEvent, type FriendPoke, type FriendRequest, type GroupNotice, type GroupRequest, type MessageEvent } from "../messages.ts";
import { authorized } from "../server.ts";
import { isRequestFlag, OneBotCalls } from "./onebot-calls.ts";
import type { OneBotGroups } from "./onebot-groups.ts";
import { decodeOneBotMessage, encodeOneBotReply } from "./onebot-message.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface ConnectionData {
  readonly calls: OneBotCalls;
  botId?: number;
  detach?: () => void;
}

function sendFrame(socket: Bun.ServerWebSocket<ConnectionData>, output: string): boolean {
  return socket.readyState === WebSocket.OPEN && socket.send(output) !== 0;
}

async function dispatchRequest(
  dispatch: (event: FriendRequest | GroupRequest) => Promise<void>,
  send: (message: string) => boolean,
  event: Record<string, unknown>,
  calls: OneBotCalls,
  permissions: { isMaster(bot: number, user: number): boolean; masterIds(bot: number): readonly number[] },
): Promise<void> {
  const { request_type, sub_type, self_id, user_id, group_id, flag } = event;
  if (!isId(self_id) || !isId(user_id) || !isRequestFlag(flag)) return;

  const common = () => ({
    post_type: "request" as const, self_id, user_id, flag,
    comment: stringField(event.comment),
    isMaster: permissions.isMaster(self_id, user_id),
    async notifyMasters(message: string) {
      if (typeof message !== "string" || !message) return 0;
      const recipients = permissions.masterIds(self_id).filter((id) => id !== self_id);
      const delivered = await Promise.all(recipients.map((user_id) =>
        calls.replyWithConfirmation(send, { message_type: "private", user_id, message, auto_escape: true })));
      return delivered.filter(Boolean).length;
    },
  });

  if (request_type === "friend") {
    if (self_id === user_id) return;
    await dispatch({
      ...common(), request_type, sub_type: "add", isGroup: false, isPrivate: true,
      approve: (approve = true, remark) => calls.reviewFriendRequest(send, flag, approve, remark),
      reply(reply) {
        const message = encodeOneBotReply(reply);
        if (message === undefined) return false;
        return calls.replyWithConfirmation(send, { message_type: "private", user_id, message, auto_escape: true });
      },
    });
    return;
  }

  if (request_type !== "group" || (sub_type !== "add" && sub_type !== "invite") || !isId(group_id)) return;

  await dispatch({
    ...common(), request_type, sub_type, group_id, isGroup: true, isPrivate: false,
    approve: (approve = true, reason) => calls.reviewGroupRequest(send, flag, sub_type, approve, reason),
    reply(reply) {
      const message = encodeOneBotReply(reply);
      if (message === undefined) return false;
      return calls.replyWithConfirmation(send, { message_type: "group", group_id, message, auto_escape: true });
    },
  });
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
    getGroupName: () => calls.getGroupName(send, group_id),
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

async function dispatchFriendPoke(
  dispatch: (event: FriendPoke) => Promise<void>,
  send: (message: string) => boolean,
  event: Record<string, unknown>,
  isMaster: (bot: number, user: number) => boolean,
): Promise<void> {
  const { self_id, target_id } = event;
  const user_id = event.user_id ?? event.operator_id;
  if (!isId(self_id) || target_id !== self_id || !isId(user_id) || user_id === self_id) return;
  await dispatch({
    post_type: "notice", notice_type: "friend", sub_type: "poke",
    self_id, user_id, operator_id: user_id, target_id,
    isGroup: false, isPrivate: true, isMaster: isMaster(self_id, user_id),
    reply(reply) {
      const message = encodeOneBotReply(reply);
      return message !== undefined && send(JSON.stringify({
        action: "send_msg", params: { message_type: "private", user_id, message, auto_escape: true },
      }));
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
  const owner = selfId !== undefined && isMaster(selfId, userId);
  const messageId = typeof event.message_id === "number" && Number.isSafeInteger(event.message_id)
    ? event.message_id : undefined;
  const sender = isRecord(event.sender) ? event.sender : undefined;
  await dispatch({
    msg: text.trim(),
    raw_message: typeof event.raw_message === "string" ? event.raw_message : stringField(event.message) ?? text,
    ...messageFields,
    file: incoming.message.find(({ type }) => type === "file"),
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
    isMaster: owner,
    likeSelf: (count) => calls.likeSelf(send, userId, count),
    isFriend: () => messageType === "private" && event.sub_type === "friend"
      ? Promise.resolve(true) : calls.isFriend(send, userId),
    reviewGroupRequest: messageType === "private" && owner
      ? (flag, type, approve, reason) => calls.reviewGroupRequest(send, flag, type, approve, reason)
      : undefined,
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
  dispatch: (event: BotEvent) => Promise<void>,
  options: {
    hostname: string;
    port: number;
    auth: Headers;
    isMaster: (bot: number, user: number) => boolean;
    masterIds: (bot: number) => readonly number[];
    groups: OneBotGroups;
    http?: (request: Request) => Response | Promise<Response>;
  },
) {
  function bind(socket: Bun.ServerWebSocket<ConnectionData>, botId: number) {
    socket.data.botId = botId;
    socket.data.detach = options.groups.connect(botId, {
      calls: socket.data.calls,
      send: (output) => sendFrame(socket, output),
    });
  }

  return Bun.serve<ConnectionData>({
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
      const header = request.headers.get("X-Self-ID");
      const id = header !== null && /^[1-9]\d*$/u.test(header) ? Number(header) : undefined;
      const data = { calls: new OneBotCalls(), botId: isId(id) ? id : undefined };
      if (!server.upgrade(request, { data })) {
        return new Response(null, { status: 426 });
      }
    },
    websocket: {
      open(socket) {
        if (socket.data.botId !== undefined) bind(socket, socket.data.botId);
      },
      async message(socket, input) {
        if (typeof input !== "string") return;
        let message: unknown;
        try {
          message = JSON.parse(input);
        } catch {
          return;
        }
        const { calls, botId } = socket.data;
        if (!isRecord(message) || calls.receive(message)) return;
        if (botId !== undefined && isId(message.self_id) && message.self_id !== botId) return;
        if (message.post_type === "meta_event") {
          if (botId === undefined && isId(message.self_id) &&
              (message.meta_event_type === "lifecycle" || message.meta_event_type === "heartbeat")) {
            bind(socket, message.self_id);
          }
          return;
        }

        try {
          const send = (output: string) => sendFrame(socket, output);
          if (message.post_type === "notice") {
            if (message.notice_type === "offline_file" && isId(message.self_id) &&
                !message.group_id && isRecord(message.file)) {
              await dispatchMessage(dispatch, send, {
                ...message, post_type: "message", message_type: "private", sub_type: "friend",
                message: [{ type: "file", data: message.file }],
              }, calls, options.isMaster);
            } else if (message.notice_type === "notify" && message.sub_type === "poke" && !message.group_id) {
              await dispatchFriendPoke(dispatch, send, message, options.isMaster);
            } else {
              await dispatchGroupNotice(dispatch, send, message, calls, options.isMaster);
            }
          } else if (message.post_type === "request") {
            await dispatchRequest(dispatch, send, message, calls, options);
          } else {
            await dispatchMessage(dispatch, send, message, calls, options.isMaster);
          }
        } catch {
          console.error("处理 OneBot 事件失败。");
        }
      },
      close(socket) {
        socket.data.detach?.();
        socket.data.calls.close();
      },
    },
  });
}
