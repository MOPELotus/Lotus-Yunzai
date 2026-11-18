import { Buffer } from "node:buffer";
import type { InboundSegment, MessageEvent, MessageReply, ReplyOptions } from "../messages.ts";
import { maxPublicFileBytes } from "../public-files.ts";

type MilkyCall = (action: string, params: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
type ScheduleRecall = (action: string, params: Record<string, unknown>, seconds: number) => void;

type OutgoingSegment =
  | { type: "text"; data: { text: string } }
  | { type: "mention"; data: { user_id: number } }
  | { type: "mention_all"; data: Record<string, never> }
  | { type: "reply"; data: { message_seq: number } }
  | { type: "face"; data: { face_id: string; is_large?: boolean } }
  | { type: "image"; data: { uri: string; sub_type: "normal" } }
  | { type: "record"; data: { uri: string } }
  | { type: "video"; data: { uri: string; thumb_uri?: string } };

type MediaType = "image" | "record" | "video";

interface ForwardNode {
  readonly user_id: number;
  readonly sender_name: string;
  readonly segments: readonly OutgoingSegment[];
}

const inlinePrefix = "base64://";
const maxMediaLinkLength = 4_096;
const maxForwardNodes = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isId(value: unknown): value is number {
  return isSequence(value) && value > 0;
}

function segmentNumber(value: unknown): unknown {
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value) ? Number(value) : value;
}

function textSegment(text: string): OutgoingSegment {
  return { type: "text", data: { text } };
}

function mentionSegment(value: unknown): OutgoingSegment | undefined {
  if (value === "all") return { type: "mention_all", data: {} };
  const userId = segmentNumber(value);
  if (isId(userId)) return { type: "mention", data: { user_id: userId } };
}

function faceId(value: unknown): string | undefined {
  const id = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (isSequence(id)) return String(id);
}

function mediaLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > maxMediaLinkLength || /[\\\s\u0000-\u001f\u007f-\u009f]/u.test(value)) return;
  const authority = /^https?:\/\/([^/?#]+)/iu.exec(value)?.[1];
  if (!authority || authority.includes("@")) return;
  const url = URL.parse(value);
  if (url?.hostname && !url.username && !url.password) return value;
}

function inlineMediaBytes(uri?: string): number {
  if (!uri?.startsWith(inlinePrefix)) return 0;
  const padding = uri.endsWith("==") ? 2 : Number(uri.endsWith("="));
  return (uri.length - inlinePrefix.length) * 3 / 4 - padding;
}

function mediaUri(value: unknown, remaining: number): string | undefined {
  if (value instanceof Uint8Array) {
    if (value.byteLength === 0 || value.byteLength > remaining) return;
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return inlinePrefix + bytes.toString("base64");
  }
  if (typeof value !== "string" || !value.startsWith(inlinePrefix)) return mediaLink(value);

  const length = value.length - inlinePrefix.length;
  if (length === 0 || length > Math.ceil(remaining / 3) * 4 || length % 4 === 1) return;
  const data = value.slice(inlinePrefix.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(data) || (data.includes("=") && length % 4 !== 0)) return;
  const canonical = data.padEnd(Math.ceil(length / 4) * 4, "=");
  const uri = inlinePrefix + canonical;
  if (inlineMediaBytes(uri) > remaining || Buffer.from(data, "base64").toString("base64") !== canonical) return;
  return uri;
}

function encodeMedia(type: MediaType, fields: Record<string, unknown>, remaining: number): OutgoingSegment | undefined {
  const uri = mediaUri(fields.file ?? fields.url, remaining);
  if (!uri) return;
  if (type === "image") return { type, data: { uri, sub_type: "normal" } };
  if (type === "record") return { type, data: { uri } };
  const thumb = fields.thumb_uri ?? fields.thumb;
  if (thumb === undefined) return { type, data: { uri } };
  const thumbUri = mediaUri(thumb, remaining - inlineMediaBytes(uri));
  if (thumbUri) return { type, data: { uri, thumb_uri: thumbUri } };
}

function encodeSegment(value: unknown, remainingMediaBytes: number): OutgoingSegment | undefined {
  if (typeof value === "string") return textSegment(value);
  if (!isRecord(value)) return;
  const fields = "data" in value ? value.data : value;
  if (!isRecord(fields)) return;

  switch (value.type) {
    case "text": return typeof fields.text === "string" ? textSegment(fields.text) : undefined;
    case "at": return mentionSegment(fields.qq);
    case "reply": {
      const sequence = segmentNumber(fields.id);
      if (isSequence(sequence)) return { type: "reply", data: { message_seq: sequence } };
      return;
    }
    case "face": {
      const id = faceId(fields.id);
      const large = fields.is_large;
      if (!id || (large !== undefined && typeof large !== "boolean")) return;
      return { type: "face", data: { face_id: id, ...(large === undefined ? {} : { is_large: large }) } };
    }
    case "image":
    case "record":
    case "video":
      return encodeMedia(value.type, fields, remainingMediaBytes);
    case "audio":
      return encodeMedia("record", fields, remainingMediaBytes);
  }
}

function encodeSegments(reply: MessageReply, remainingMediaBytes: number) {
  const message: OutgoingSegment[] = [];
  for (const part of Array.isArray(reply) ? reply : [reply]) {
    const encoded = encodeSegment(part, remainingMediaBytes);
    if (!encoded) return;
    if (encoded.type === "image" || encoded.type === "record" || encoded.type === "video") {
      remainingMediaBytes -= inlineMediaBytes(encoded.data.uri);
      if (encoded.type === "video") remainingMediaBytes -= inlineMediaBytes(encoded.data.thumb_uri);
    }
    message.push(encoded);
  }
  if (message.length === 0) return;
  return { message, remainingMediaBytes };
}

function encodeReply(reply: MessageReply, quoteId: number | undefined, mention: ReplyOptions["at"]): OutgoingSegment[] | undefined {
  const encoded = encodeSegments(reply, maxPublicFileBytes);
  if (!encoded) return;
  const { message } = encoded;
  if (mention !== undefined && mention !== false) {
    const encoded = mentionSegment(mention);
    if (!encoded) return;
    message.unshift(encoded, textSegment("\n"));
  }
  if (quoteId !== undefined && !message.some(({ type }) => type === "reply")) {
    message.unshift({ type: "reply", data: { message_seq: quoteId } });
  }
  return message;
}

function encodeForward(nodes: readonly MessageReply[], selfId: number): ForwardNode[] | undefined {
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > maxForwardNodes) return;
  const messages: ForwardNode[] = [];
  let remainingMediaBytes = maxPublicFileBytes;
  for (const node of nodes) {
    const encoded = encodeSegments(node, remainingMediaBytes);
    if (!encoded) return;
    remainingMediaBytes = encoded.remainingMediaBytes;
    messages.push({ user_id: selfId, sender_name: "Lotus-Yunzai", segments: encoded.message });
  }
  return messages;
}

function mediaText(value: unknown): string | undefined {
  if (typeof value === "string" && value.length <= maxMediaLinkLength && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return value;
}

function mediaInt(value: unknown, minimum: number): number | undefined {
  if (isSequence(value) && value >= minimum && value <= 2_147_483_647) return value;
}

function decodeMedia(type: MediaType, data: Record<string, unknown>, url?: string): InboundSegment {
  const media: { type: MediaType; [key: string]: unknown } = { type };
  if (url) {
    media.url = url;
    media.file = url;
  }
  const resourceId = mediaText(data.resource_id);
  if (resourceId !== undefined) media.resource_id = resourceId;
  if (type !== "record") {
    const width = mediaInt(data.width, 1);
    const height = mediaInt(data.height, 1);
    if (width !== undefined) media.width = width;
    if (height !== undefined) media.height = height;
  }
  if (type === "image") {
    const summary = mediaText(data.summary);
    if (summary !== undefined) media.summary = summary;
    if (data.sub_type === "normal" || data.sub_type === "sticker") media.sub_type = data.sub_type;
  } else {
    const duration = mediaInt(data.duration, 0);
    if (duration !== undefined) media.duration = duration;
  }
  return media;
}

function decodeSegments(value: unknown, selfId: number) {
  if (!Array.isArray(value) || value.length === 0) return;
  const message: InboundSegment[] = [];
  const text: string[] = [];
  const raw: string[] = [];
  const img: string[] = [];
  let atBot = false;
  let at: string | undefined;
  let replyId: string | undefined;
  for (const part of value) {
    if (!isRecord(part) || typeof part.type !== "string" || !isRecord(part.data)) return;
    const { type, data } = part;
    switch (type) {
      case "text":
        if (typeof data.text !== "string") return;
        message.push({ type, text: data.text });
        text.push(data.text);
        raw.push(data.text);
        continue;
      case "mention": {
        if (!isId(data.user_id)) return;
        const qq = String(data.user_id);
        message.push({ type: "at", qq });
        if (data.user_id === selfId) atBot = true;
        else at = qq;
        raw.push("[at]");
        break;
      }
      case "mention_all":
        message.push({ type: "at", qq: "all" });
        at = "all";
        raw.push("[at]");
        break;
      case "reply":
        if (!isSequence(data.message_seq)) return;
        replyId = String(data.message_seq);
        message.push({ type, id: replyId });
        raw.push("[reply]");
        break;
      case "face":
      case "face_incoming": {
        const id = faceId(data.face_id);
        if (!id) return;
        const large = data.is_large;
        message.push({ type: "face", id, ...(typeof large === "boolean" ? { is_large: large } : {}) });
        raw.push("[face]");
        break;
      }
      case "image":
      case "audio":
      case "record":
      case "video": {
        const kind = type === "audio" ? "record" : type;
        const url = mediaLink(data.temp_url);
        message.push(decodeMedia(kind, data, url));
        if (kind === "image" && url) img.push(url);
        raw.push(`[${kind}]`);
        break;
      }
      default:
        if (!/^[a-z][a-z0-9_]{0,63}$/u.test(type)) return;
        message.push({ type, data });
        raw.push(`[${type}]`);
    }
  }

  return { message, text: text.join(""), raw: raw.join(""), atBot, at, replyId, img: img.length ? img : undefined };
}

function matchingProfile(value: unknown, userId: number, groupId?: number) {
  if (isRecord(value) && value.user_id === userId && (groupId === undefined || value.group_id === groupId)) return value;
}

function memberRole(value: unknown) {
  if (value === "owner" || value === "admin" || value === "member") return value;
}

function displayName(value: unknown): string | undefined {
  if (typeof value === "string" && value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) return value;
}

function senderMetadata(data: Record<string, unknown>, groupId: number | undefined, userId: number) {
  const profile = matchingProfile(groupId === undefined ? data.friend : data.group_member, userId, groupId);
  const sender: Record<string, unknown> = { user_id: userId };
  const nickname = displayName(profile?.nickname);
  if (nickname !== undefined) sender.nickname = nickname;
  if (groupId === undefined) {
    const remark = displayName(profile?.remark);
    if (remark !== undefined) sender.remark = remark;
    return { sender };
  }
  const card = displayName(profile?.card);
  if (card !== undefined) sender.card = card;
  const role = memberRole(profile?.role);
  if (!role) return { sender };
  sender.role = role;
  return { sender, member: { is_admin: role === "admin", is_owner: role === "owner" } };
}

export function milkyMessage(
  value: unknown, selfId: number, call: MilkyCall, scheduleRecall?: ScheduleRecall, forwardCall?: MilkyCall,
): MessageEvent | undefined {
  if (!isId(selfId) || !isRecord(value) || value.event_type !== "message_receive" || value.self_id !== selfId ||
      !isRecord(value.data)) return;
  const { message_scene: scene, sender_id: userId, peer_id: peerId, message_seq: messageId, segments } = value.data;
  if ((scene !== "group" && scene !== "friend") || !isId(userId) || userId === selfId || !isId(peerId) ||
      (scene === "friend" && peerId !== userId) || !isSequence(messageId)) return;
  const incoming = decodeSegments(segments, selfId);
  if (!incoming) return;

  const isGroup = scene === "group";
  const target = isGroup ? { group_id: peerId } : { user_id: peerId };
  const action = isGroup ? "send_group_message" : "send_private_message";
  return {
    post_type: "message",
    message_type: isGroup ? "group" : "private",
    sub_type: isGroup ? "normal" : "friend",
    self_id: selfId, user_id: userId, group_id: isGroup ? peerId : undefined, message_id: messageId,
    ...senderMetadata(value.data, isGroup ? peerId : undefined, userId),
    msg: incoming.text.trim(), raw_message: incoming.raw, message: incoming.message,
    atBot: incoming.atBot, at: incoming.at, reply_id: incoming.replyId, img: incoming.img,
    isGroup, isPrivate: !isGroup, isMaster: false, boundAccount: false,
    async getGroupRole(groupId) {
      if (!isId(groupId)) return;
      try {
        const result = await call("get_group_member_info", { group_id: groupId, user_id: userId, no_cache: true });
        return memberRole(matchingProfile(result?.member, userId, groupId)?.role);
      } catch {
        return undefined;
      }
    },
    async isFriend() {
      if (!isGroup) return true;
      const result = await call("get_friend_info", { user_id: userId, no_cache: true });
      return isRecord(result?.friend) && result.friend.user_id === userId;
    },
    async likeSelf(count) {
      if (!Number.isInteger(count) || count < 1 || count > 10) return 0;
      const result = await call("send_profile_like", { user_id: userId, count });
      return result === undefined ? 0 : count;
    },
    forward: forwardCall && (async (nodes) => {
      const messages = encodeForward(nodes, selfId);
      if (!messages) return false;
      const result = await forwardCall(action, { ...target, message: [{ type: "forward", data: { messages } }] });
      if (result === undefined) return false;
      if (!isSequence(result?.message_seq)) throw new Error("Milky 合并转发结果未确认。");
      return true;
    }),
    async reply(reply, quote = false, options = {}) {
      const mention = isGroup ? options.at === true ? userId : options.at : undefined;
      const message = encodeReply(reply, quote ? messageId : undefined, mention);
      if (!message) return false;
      try {
        const sequence = (await call(action, { ...target, message }))?.message_seq;
        if (!isSequence(sequence)) return false;
        const seconds = options.recallMsg;
        if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && seconds <= 120) {
          scheduleRecall?.(isGroup ? "recall_group_message" : "recall_private_message", { ...target, message_seq: sequence }, seconds);
        }
        return true;
      } catch {
        return false;
      }
    },
  };
}
