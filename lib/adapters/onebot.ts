import { isChatFileName, maxChatFileBytes, readQqChatFile, type IncomingChatFile } from "../chat-files.ts";
import { segment, type BotEvent, type FriendPoke, type FriendRequest, type GroupNotice, type GroupRequest, type MessageEvent, type MessageReply, type QuotedMessage } from "../messages.ts";
import { authorized } from "../server.ts";
import { isRequestFlag, OneBotCalls, type OneBotAction, type Send } from "./onebot-calls.ts";
import type { OneBotGroups } from "./onebot-groups.ts";
import { OneBotMemberDisplay } from "./onebot-member-display.ts";
import { decodeOneBotMessage, encodeOneBotReply } from "./onebot-message.ts";
import { OneBotMutes } from "./onebot-mutes.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function oneBotMessageId(value: unknown): number | undefined {
  const id = typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : value;
  if (typeof id === "number" && Number.isInteger(id) && id !== 0 && id >= -2_147_483_648 && id <= 2_147_483_647) return id;
}

async function readOneBotQuote(
  calls: OneBotCalls, send: Send, id: number, selfId: number, target: { group_id: number } | { user_id: number },
): Promise<QuotedMessage | undefined> {
  const quote = await calls.getMessage(send, id);
  if (!quote || oneBotMessageId(quote.message_id) !== id || ("self_id" in quote && quote.self_id !== selfId)) return;
  const sender = isRecord(quote.sender) ? quote.sender.user_id : undefined;
  if (!isId(sender)) return;
  if ("group_id" in target) {
    if (quote.message_type !== "group" || quote.group_id !== target.group_id) return;
  } else {
    if (quote.message_type !== "private" || isId(quote.group_id) || ("sub_type" in quote && quote.sub_type !== "friend")) return;
    if (("target_id" in quote && quote.target_id !== (sender === selfId ? target.user_id : selfId)) ||
        (sender !== target.user_id && (sender !== selfId || quote.target_id !== target.user_id))) return;
  }
  const message = decodeOneBotMessage(quote.message, selfId)?.message;
  if (message) return { user_id: sender, message };
}

interface ConnectionData {
  readonly calls: OneBotCalls;
  readonly mutes: OneBotMutes;
  readonly attachmentSession?: AbortController;
  botId?: number;
  detach?: () => void;
  display?: OneBotMemberDisplay;
  skipInitialRoster?: Set<number>;
  joinRoster?: Map<number, symbol>;
}

function attachmentSize(value: unknown): number | undefined {
  const size = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof size === "number" && Number.isSafeInteger(size) && size > 0 && size <= maxChatFileBytes) return size;
}

function attachmentId(value: unknown, name: string): string | undefined {
  if (typeof value === "string" && value !== name && value.length <= 1024 && /^\/?[A-Za-z0-9_+-]+={0,2}$/u.test(value)) {
    return value;
  }
}

function incomingAttachment(
  session: AbortSignal, calls: OneBotCalls, send: Send, target: { group_id: number } | { user_id: number },
  data: Record<string, unknown>, source: "message" | "group_upload" | "offline_file",
): IncomingChatFile | undefined {
  if (session.aborted) return;
  const name = source === "message" ? data.file : data.name;
  if (!isChatFileName(name)) return;
  const rawSize = source === "message" ? data.file_size : data.size;
  const size = attachmentSize(rawSize);
  if (rawSize !== undefined && size === undefined) return;
  const fileId = attachmentId(source === "group_upload" ? data.id : data.file_id, name);
  const busid = "group_id" in target && typeof data.busid === "number" && Number.isSafeInteger(data.busid) && data.busid >= 0
    ? data.busid : undefined;
  const directUrl = source === "offline_file" && typeof data.url === "string" ? data.url : undefined;
  if (!fileId && directUrl === undefined) return;
  const fileTarget = busid !== undefined ? { ...target, busid } : target;
  return Object.freeze({
    name, size,
    async read(signal?: AbortSignal) {
      const readSignal = signal ? AbortSignal.any([session, signal]) : session;
      if (readSignal.aborted) return;
      return fileId ? calls.readFile(send, fileTarget, fileId, name, size, readSignal) : readQqChatFile(directUrl, size, readSignal);
    },
  });
}

function structuredAttachment(message: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(message)) return;
  const files = message.filter((part: unknown) => isRecord(part) && part.type === "file");
  const data = files.length === 1 ? files[0]?.data : undefined;
  return isRecord(data) ? data : undefined;
}

function sendFrame(socket: Bun.ServerWebSocket<ConnectionData>, output: string): boolean {
  return socket.readyState === WebSocket.OPEN && socket.send(output) !== 0;
}

function isLoopback(address?: string): boolean {
  return address === "::1" || /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/u.test(address ?? "");
}

interface MessageIdentity {
  self_id?: number;
  user_id?: number;
  group_id?: number;
}

function sentMessage(frame: OneBotAction, source: MessageIdentity, record: (identity: MessageIdentity, message?: unknown) => void) {
  if (!isRecord(frame.params)) return;
  const { group_id, user_id, message, messages } = frame.params;
  const group = isId(group_id) ? group_id : undefined;
  const identity = {
    self_id: source.self_id,
    group_id: group,
    user_id: group !== undefined
      ? (group === source.group_id ? source.user_id : undefined)
      : (isId(user_id) ? user_id : undefined),
  };
  if (frame.action === "send_msg") record(identity, message);
  else if (frame.action === "send_group_forward_msg" || frame.action === "send_private_forward_msg") record(identity, messages);
}

async function dispatchRequest(
  dispatch: (event: FriendRequest | GroupRequest) => Promise<void>,
  send: Send,
  event: Record<string, unknown>,
  calls: OneBotCalls,
  permissions: { isMaster(bot: number, user: number): boolean; masterIds(bot: number): readonly number[] },
): Promise<void> {
  const { request_type, sub_type, self_id, user_id, group_id, flag } = event;
  if (!isId(self_id) || !isId(user_id) || !isRequestFlag(flag)) return;

  function replyToApplicant(reply: MessageReply): boolean | Promise<boolean> {
    const message = encodeOneBotReply(reply);
    return message !== undefined &&
      calls.replyWithConfirmation(send, { message_type: "private", user_id, message, auto_escape: true });
  }

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
      reply: replyToApplicant,
    });
    return;
  }

  if (request_type !== "group" || (sub_type !== "add" && sub_type !== "invite") || !isId(group_id)) return;

  await dispatch({
    ...common(), request_type, sub_type, group_id, isGroup: true, isPrivate: false,
    group_name: stringField(event.group_name),
    approve: (approve = true, reason) => calls.reviewGroupRequest(send, flag, sub_type, approve, reason),
    replyToApplicant,
    reply(reply) {
      const message = encodeOneBotReply(reply);
      if (message === undefined) return false;
      return calls.replyWithConfirmation(send, { message_type: "group", group_id, message, auto_escape: true });
    },
  });
}

async function dispatchGroupNotice(
  dispatch: (event: GroupNotice) => Promise<void>,
  send: Send,
  event: Record<string, unknown>,
  calls: OneBotCalls,
  isMaster: (bot: number, user: number) => boolean,
  connection: ConnectionData,
): Promise<void> {
  const { notice_type, user_id, group_id, self_id, operator_id, time } = event;
  if (notice_type !== "group_increase" && notice_type !== "group_decrease") return;
  if (!isId(user_id) || !isId(group_id) || !isId(self_id)) return;

  const sub_type = notice_type === "group_increase" ? "increase" : "decrease";
  const action = stringField(event.sub_type);
  const source = isRecord(event.member) ? event.member : undefined;
  const display = self_id === connection.botId && connection.display?.closed === false ? connection.display : undefined;
  const cached = display?.peek(group_id, user_id);
  const nickname = stringField(event.nickname);
  const member = source || cached ? {
    card: stringField(source?.card) ?? cached?.card,
    nickname: stringField(source?.nickname) ?? (display ? nickname ?? cached?.nickname : undefined),
  } : undefined;
  const selfJoined = sub_type === "increase" && user_id === self_id && self_id === connection.botId;
  const joins = display ? connection.joinRoster : undefined;
  const join = selfJoined && joins ? Symbol() : undefined;
  if (display) {
    if (user_id === self_id) {
      connection.skipInitialRoster?.add(group_id);
      if (join) joins?.set(group_id, join);
      else {
        joins?.delete(group_id);
        display.forget(group_id);
      }
    } else if (sub_type === "decrease") {
      display.remove(group_id, user_id);
    } else {
      display.remember(group_id, user_id, { card: stringField(source?.card), nickname: stringField(source?.nickname) ?? nickname });
    }
  }
  let left = false;
  const notice: GroupNotice = {
    post_type: "notice",
    notice_type: "group",
    sub_type,
    time: isId(time) ? time : undefined,
    action_sub_type: action,
    increase_type: sub_type === "increase" ? action : undefined,
    decrease_type: sub_type === "decrease" ? action : undefined,
    inviter_id: sub_type === "increase" && action === "invite" && isId(operator_id) ? operator_id : undefined,
    user_id, group_id, self_id,
    operator_id: isId(operator_id) ? operator_id : undefined,
    group_name: stringField(event.group_name),
    getGroupName: () => calls.getGroupName(send, group_id),
    inspectAutoQuit: selfJoined && isId(time) ? (maxMembers) => calls.inspectAutoQuit(send, group_id, self_id, time, maxMembers) : undefined,
    leaveGroup: selfJoined && isId(time) ? async () => {
      const accepted = await calls.leaveGroup(send, group_id);
      left ||= accepted;
      if (accepted && join && joins?.get(group_id) === join) display?.forget(group_id);
      return accepted;
    } : undefined,
    nickname: nickname ?? (display ? member?.nickname : undefined),
    member,
    dismiss: typeof event.dismiss === "boolean" ? event.dismiss : undefined,
    isGroup: true,
    isPrivate: false,
    isMaster: isId(operator_id) && isMaster(self_id, operator_id),
    reply(reply) {
      const message = encodeOneBotReply(reply);
      if (message === undefined) return false;
      return calls.replyWithConfirmation(send, { message_type: "group", group_id, message, auto_escape: true });
    },
  };
  try {
    await dispatch(notice);
    if (join && joins?.get(group_id) === join && !left) void display?.warm(group_id);
  } finally {
    if (join && joins?.get(group_id) === join) joins?.delete(group_id);
  }
}

async function dispatchFriendPoke(
  dispatch: (event: FriendPoke) => Promise<void>,
  send: Send,
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
      return message !== undefined && send({
        action: "send_msg", params: { message_type: "private", user_id, message, auto_escape: true },
      });
    },
  });
}

async function dispatchMessage(
  dispatch: (event: MessageEvent) => Promise<void>,
  send: Send,
  event: Record<string, unknown>,
  calls: OneBotCalls,
  isMaster: (bot: number, user: number) => boolean,
  connection?: ConnectionData,
  noticeAttachment?: IncomingChatFile,
): Promise<void> {
  const { mutes, botId: connectedBotId, display, attachmentSession } = connection ?? {};
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
  const boundAccount = selfId !== undefined && selfId === connectedBotId;
  const rawFile = !noticeAttachment && boundAccount && attachmentSession ? structuredAttachment(event.message) : undefined;
  const attachment = noticeAttachment ?? (rawFile && attachmentSession
    ? incomingAttachment(attachmentSession.signal, calls, send, target, rawFile, "message") : undefined);
  const { text, ...messageFields } = incoming;
  const sender = isRecord(event.sender) ? event.sender : undefined;
  if (selfId !== undefined && selfId === connectedBotId && "group_id" in target && sender) {
    display?.remember(target.group_id, userId, { card: stringField(sender.card), nickname: stringField(sender.nickname) });
  }

  const messageType = event.message_type;
  const botMute = mutes && selfId !== undefined && "group_id" in target
    ? await mutes.forMessage(target.group_id, selfId, () => calls.getGroupRole(send, target.group_id, selfId))
    : undefined;
  const owner = selfId !== undefined && isMaster(selfId, userId);
  const messageId = typeof event.message_id === "number" && Number.isSafeInteger(event.message_id)
    ? event.message_id : undefined;
  const quotedId = oneBotMessageId(incoming.reply_id);
  let quoted: Promise<QuotedMessage | undefined> | undefined;
  await dispatch({
    msg: text.trim(),
    raw_message: typeof event.raw_message === "string" ? event.raw_message : stringField(event.message) ?? text,
    ...messageFields,
    file: incoming.message.find(({ type }) => type === "file"),
    attachment,
    canReadAttachments: boundAccount && !!attachmentSession && !attachmentSession.signal.aborted,
    attachmentOnly: noticeAttachment !== undefined && messageType === "group" ? true : undefined,
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
    botMute,
    isGroup: messageType === "group",
    isPrivate: messageType === "private",
    isMaster: owner,
    boundAccount,
    likeSelf: (count) => calls.likeSelf(send, userId, count),
    isFriend: () => messageType === "private" && event.sub_type === "friend"
      ? Promise.resolve(true) : calls.isFriend(send, userId),
    getGroupRole: selfId !== undefined && selfId === connectedBotId
      ? (id) => isId(id) ? calls.getGroupRole(send, id, userId, true) : Promise.resolve(undefined)
      : undefined,
    listCheckinGroupMembers: boundAccount && display && "group_id" in target ? async () => {
      if (display.closed) return;
      const members = await calls.listMemberDisplay(send, target.group_id, true);
      if (display.closed) return;
      return members.map(({ id, card, nickname }) => ({ id, name: card || nickname }));
    } : undefined,
    forward: selfId === undefined ? undefined : async (nodes) => {
      const messages = [];
      for (const node of nodes) {
        const content = encodeOneBotReply(typeof node === "string" ? [node] : node);
        if (!Array.isArray(content)) return false;
        messages.push({ type: "node", data: { uin: String(selfId), name: "Lotus-Yunzai", content } });
      }
      return messages.length > 0 && calls.sendForward(send, target, messages);
    },
    uploadFile: boundAccount && attachmentSession && display?.closed === false
      ? (file) => display.closed || attachmentSession.signal.aborted ? Promise.resolve("rejected") : calls.uploadFile(send, target, file)
      : undefined,
    reviewGroupRequest: messageType === "private" && owner
      ? (flag, type, approve, reason) => calls.reviewGroupRequest(send, flag, type, approve, reason)
      : undefined,
    recallReply: owner && selfId === connectedBotId ? () => {
      const ids = new Set([oneBotMessageId(messageId), quotedId].filter((id) => id !== undefined));
      return Promise.all([...ids].map((id) => calls.recallMessage(send, id)));
    } : undefined,
    lookupReply: quotedId !== undefined && selfId !== undefined && selfId === connectedBotId &&
      (messageType === "group" || event.sub_type === "friend")
      ? () => quoted ??= readOneBotQuote(calls, send, quotedId, selfId, target)
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
      return send({ action: "send_msg", params });
    },
  });
}

export function startOneBot(
  dispatch: (event: BotEvent) => Promise<void>,
  options: {
    hostname: string;
    port: number;
    tls?: Bun.TLSOptions;
    auth: Headers;
    isMaster: (bot: number, user: number) => boolean;
    masterIds: (bot: number) => readonly number[];
    groups: OneBotGroups;
    prewarmGroupMembers?: boolean;
    accepting?: () => boolean;
    onBind?: (botId: number) => void;
    onSent?: (identity: MessageIdentity, message?: unknown) => void;
    http?: (request: Request) => Response | Promise<Response>;
  },
) {
  const authenticated = [...options.auth].length > 0;

  function sender(socket: Bun.ServerWebSocket<ConnectionData>, source: MessageIdentity): Send {
    return (frame) => {
      const sent = sendFrame(socket, JSON.stringify(frame));
      if (sent && options.onSent) sentMessage(frame, source, options.onSent);
      return sent;
    };
  }

  function bind(socket: Bun.ServerWebSocket<ConnectionData>, botId: number) {
    socket.data.botId = botId;
    const send = sender(socket, { self_id: botId });
    const display = new OneBotMemberDisplay((groupId) => socket.data.calls.listMemberDisplay(send, groupId));
    socket.data.display = display;
    socket.data.detach = options.groups.connect(botId, {
      calls: socket.data.calls,
      send,
      retireMemberDisplay: () => {
        display.close();
        socket.data.attachmentSession?.abort();
      },
    });
    options.onBind?.(botId);
    if (options.prewarmGroupMembers) {
      socket.data.joinRoster = new Map();
      const skipped = new Set<number>();
      socket.data.skipInitialRoster = skipped;
      void (async () => {
        try {
          const groups = await socket.data.calls.listGroups(send);
          for (const groupId of new Set(groups.map(({ id }) => id))) {
            if (display.closed) break;
            if (!skipped.has(groupId)) await display.warm(groupId);
          }
        } catch {
          // Roster prewarming is optional and does not affect the connection.
        } finally {
          socket.data.skipInitialRoster = undefined;
        }
      })();
    }
  }

  return Bun.serve<ConnectionData>({
    hostname: options.hostname,
    port: options.port,
    tls: options.tls,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path !== "/OneBotv11" && path !== "/OneBotv11/") {
        return options.http?.(request) ?? new Response(null, { status: 404 });
      }
      if (options.accepting?.() === false) return new Response(null, { status: 503 });
      if (!authorized(request, options.auth)) {
        return new Response(null, { status: 401 });
      }
      if (request.headers.get("X-Client-Role")?.toLowerCase() !== "universal") {
        return new Response("需要 OneBot 11 Universal 连接。", { status: 400 });
      }
      const header = request.headers.get("X-Self-ID");
      const id = header !== null && /^[1-9]\d*$/u.test(header) ? Number(header) : undefined;
      const data = { calls: new OneBotCalls(), mutes: new OneBotMutes(), botId: isId(id) ? id : undefined,
        attachmentSession: authenticated || isLoopback(server.requestIP(request)?.address) ? new AbortController() : undefined };
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
        const { calls, botId, mutes, attachmentSession } = socket.data;
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
          const send = sender(socket, {
            self_id: isId(message.self_id) ? message.self_id : botId,
            user_id: isId(message.user_id) ? message.user_id : undefined,
            group_id: isId(message.group_id) ? message.group_id : undefined,
          });
          if (message.post_type === "notice") {
            if (isId(message.group_id) && isId(message.self_id)) mutes.observe(message.group_id, message.self_id, message);
            if (message.notice_type === "group_card" && botId !== undefined && message.self_id === botId &&
                isId(message.group_id) && isId(message.user_id) && typeof message.card_new === "string") {
              socket.data.display?.remember(message.group_id, message.user_id, { card: message.card_new });
            } else if (message.notice_type === "group_upload") {
              if (!attachmentSession || botId === undefined || message.self_id !== botId || !isId(message.user_id) ||
                  !isId(message.group_id) || !isRecord(message.file)) return;
              const attachment = incomingAttachment(attachmentSession.signal, calls, send, { group_id: message.group_id }, message.file,
                "group_upload");
              if (!attachment) return;
              await dispatchMessage(dispatch, send, {
                ...message, post_type: "message", message_type: "group", sub_type: "normal", message_id: undefined, raw_message: undefined,
                message: [{ type: "file", data: message.file }],
              }, calls, options.isMaster, socket.data, attachment);
            } else if (message.notice_type === "offline_file" && isId(message.self_id) &&
                !message.group_id && isRecord(message.file)) {
              const attachment = isId(message.user_id) && message.self_id === botId && attachmentSession
                ? incomingAttachment(attachmentSession.signal, calls, send, { user_id: message.user_id }, message.file, "offline_file")
                : undefined;
              await dispatchMessage(dispatch, send, {
                ...message, post_type: "message", message_type: "private", sub_type: "friend",
                message: [{ type: "file", data: message.file }],
              }, calls, options.isMaster, undefined, attachment);
            } else if (message.notice_type === "notify" && message.sub_type === "poke" && !message.group_id) {
              await dispatchFriendPoke(dispatch, send, message, options.isMaster);
            } else {
              await dispatchGroupNotice(dispatch, send, message, calls, options.isMaster, socket.data);
            }
          } else if (message.post_type === "request") {
            await dispatchRequest(dispatch, send, message, calls, options);
          } else {
            await dispatchMessage(dispatch, send, message, calls, options.isMaster, socket.data);
          }
        } catch {
          console.error("处理 OneBot 事件失败。");
        }
      },
      close(socket) {
        socket.data.detach?.();
        socket.data.display?.close();
        socket.data.attachmentSession?.abort();
        socket.data.calls.close();
      },
    },
  });
}
