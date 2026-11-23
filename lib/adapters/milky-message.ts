import { Buffer } from "node:buffer";
import { encodeChatFile, isChatFileName, maxChatFileBytes, readQqChatFile, type ChatFile, type IncomingChatFile } from "../chat-files.ts";
import { sendSessionMedia } from "../media-delivery.ts";
import { generatedImagePreview, notifyReplyDelivery, replyRecallSeconds, type InboundSegment, type MessageEvent, type MessageReply, type QuotedMessage, type ReplyOptions } from "../messages.ts";
import { maxPublicFileBytes } from "../public-files.ts";
import type { MilkyConfirmation } from "./milky-api.ts";

type MilkyCall = (action: string, params: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
type MilkyConfirmedCall = (action: string, params: Record<string, unknown>) => Promise<MilkyConfirmation>;
type ScheduleRecall = (action: string, params: Record<string, unknown>, seconds: number) => void;
type Target = { group_id: number } | { user_id: number };

type OutgoingSegment =
  | { type: "text"; data: { text: string } }
  | { type: "mention"; data: { user_id: number } }
  | { type: "mention_all"; data: Record<string, never> }
  | { type: "reply"; data: { message_seq: number } }
  | { type: "face"; data: { face_id: string; is_large?: boolean } }
  | { type: "image"; data: { uri: string; sub_type: "normal"; summary?: string } }
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
const fileCorrelations = new WeakMap<InboundSegment, string>();

export function getMilkyFileCorrelation(segment: InboundSegment): string | undefined {
  return fileCorrelations.get(segment);
}

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
  const file = fields.file ?? fields.url;
  const uri = mediaUri(file, remaining);
  if (!uri) return;
  if (type === "image") {
    const summary = typeof fields.summary === "string" ? fields.summary : generatedImagePreview(file, fields);
    return { type, data: { uri, sub_type: "normal", ...(summary === undefined ? {} : { summary }) } };
  }
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

export function encodeMilkyReply(reply: MessageReply, quoteId?: number, mention?: ReplyOptions["at"]): OutgoingSegment[] | undefined {
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

export function encodeMilkyForward(nodes: readonly MessageReply[], selfId: number, senderName = "Lotus-Yunzai"): ForwardNode[] | undefined {
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > maxForwardNodes) return;
  const messages: ForwardNode[] = [];
  let remainingMediaBytes = maxPublicFileBytes;
  for (const node of nodes) {
    const encoded = encodeSegments(node, remainingMediaBytes);
    if (!encoded) return;
    remainingMediaBytes = encoded.remainingMediaBytes;
    messages.push({ user_id: selfId, sender_name: senderName, segments: encoded.message });
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

function opaqueFileField(value: unknown): string | undefined {
  const field = mediaText(value);
  if (field && field.isWellFormed() && !/\s/u.test(field)) return field;
}

function decodeResource(kind: "image" | "record" | "video", data: Record<string, unknown>, url: string | undefined,
  call: MilkyCall): InboundSegment {
  const media = decodeMedia(kind, data, url);
  const resourceId = opaqueFileField(data.resource_id);
  if (!resourceId) return media;
  let downloadUrl: Promise<string | undefined> | undefined;
  async function resolveUrl() {
    try {
      return mediaLink((await call("get_resource_temp_url", { resource_id: resourceId }))?.url);
    } catch {
      return undefined;
    }
  }
  return { ...media, getDownloadUrl: () => downloadUrl ??= resolveUrl() };
}

function decodeFile(data: Record<string, unknown>, target: Target, call: MilkyCall): InboundSegment | undefined {
  const file = opaqueFileField(data.file_id);
  const name = mediaText(data.file_name);
  const size = data.file_size;
  if (!file || !name?.trim() || !name.isWellFormed() || name === "." || name === ".." ||
      /[/\\\u2028\u2029]/u.test(name) || !isSequence(size)) return;

  const segment = { type: "file", file, name, size };
  const hash = opaqueFileField(data.file_hash);
  const query = "group_id" in target
    ? { action: "get_group_file_download_url", params: { group_id: target.group_id, file_id: file } }
    : hash === undefined ? undefined : {
      action: "get_private_file_download_url", params: { user_id: target.user_id, file_id: file, file_hash: hash },
    };
  if (!query) return segment;
  const downloadable = {
    ...segment,
    async getDownloadUrl() {
      try {
        return mediaLink((await call(query.action, query.params))?.download_url);
      } catch {
        return undefined;
      }
    },
  };
  if (hash && "user_id" in target) fileCorrelations.set(downloadable, hash);
  return downloadable;
}

function milkyAttachment(segment: InboundSegment | undefined): IncomingChatFile | undefined {
  if (!segment) return;
  const { name, size, getDownloadUrl } = segment;
  if (!isChatFileName(name) || !isId(size) || size > maxChatFileBytes || typeof getDownloadUrl !== "function") return;
  let downloading: Promise<Uint8Array | undefined> | undefined;
  const download = async (signal?: AbortSignal): Promise<Uint8Array | undefined> => {
    const url = await getDownloadUrl();
    if (!signal?.aborted && typeof url === "string") return readQqChatFile(url, size, signal);
  };
  return Object.freeze({
    name,
    size,
    async read(signal?: AbortSignal) {
      if (signal?.aborted) return;
      const bytes = await (downloading ??= download(signal));
      if (!signal?.aborted) return bytes;
    },
  });
}

function decodeSegments(value: unknown, selfId: number, target: Target, call: MilkyCall) {
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
        message.push(decodeResource(kind, data, url, call));
        if (kind === "image" && url) img.push(url);
        raw.push(`[${kind}]`);
        break;
      }
      case "file": {
        const file = decodeFile(data, target, call);
        if (!file) return;
        message.push(file);
        raw.push("[file]");
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

export function decodeMilkyTemporaryMessage(segments: unknown, account: number, userId: number, call: MilkyCall) {
  if (!Array.isArray(segments) || !segments.every(part => isRecord(part) &&
    (part.type === "text" || part.type === "image" || part.type === "face" || part.type === "face_incoming" ||
      ((part.type === "record" || part.type === "video") && segments.length === 1)))) return;
  return decodeSegments(segments, account, { user_id: userId }, call)?.message;
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

function replyToMilky(target: Target, call: MilkyCall, {
  messageId, groupSender, scheduleRecall,
}: { messageId?: number; groupSender?: number; scheduleRecall?: ScheduleRecall } = {}): MessageEvent["reply"] {
  const group = "group_id" in target;
  const action = group ? "send_group_message" : "send_private_message";
  return async (reply, quote = false, options = {}) => {
    if (quote && messageId === undefined) return false;
    const mention = group ? options.at === true ? groupSender : options.at : undefined;
    const message = encodeMilkyReply(reply, quote ? messageId : undefined, mention);
    if (!message || (messageId === undefined && message.some(({ type }) => type === "reply"))) return false;
    try {
      const sequence = (await call(action, { ...target, message }))?.message_seq;
      if (!isSequence(sequence)) return false;
      const seconds = replyRecallSeconds(options.recallMsg);
      if (seconds !== undefined) {
        scheduleRecall?.(group ? "recall_group_message" : "recall_private_message", { ...target, message_seq: sequence }, seconds);
      }
      await notifyReplyDelivery(options.onDelivered, sequence);
      return true;
    } catch {
      return false;
    }
  };
}

async function uploadMilkyFile(target: Target, confirm: MilkyConfirmedCall, file_uri: string, file_name: string) {
  const group = "group_id" in target;
  const action = group ? "upload_group_file" : "upload_private_file";
  const destination = group ? { ...target, parent_folder_id: "/" } : target;
  try {
    const result = await confirm(action, { ...destination, file_uri, file_name });
    if (result.status === "rejected") return "rejected";
    return result.status === "confirmed" && opaqueFileField(result.data.file_id) ? "confirmed" : "unknown";
  } catch {
    return "unknown";
  }
}

export async function uploadMilkyChatFile(target: Target, file: ChatFile, confirm: MilkyConfirmedCall) {
  const fileUri = encodeChatFile(file);
  return fileUri ? uploadMilkyFile(target, confirm, fileUri, file.name) : "rejected";
}

function uploadToMilky(target: Target, confirm: MilkyConfirmedCall): NonNullable<MessageEvent["uploadFile"]> {
  return file => uploadMilkyChatFile(target, file, confirm);
}

export function milkyFriendFileUpload(
  value: unknown, selfId: number, call: MilkyCall, uploadCall?: MilkyConfirmedCall,
): MessageEvent | undefined {
  if (!isId(selfId) || !isRecord(value) || value.event_type !== "friend_file_upload" || value.self_id !== selfId ||
      !isRecord(value.data)) return;
  const { user_id: userId, is_self: ownUpload } = value.data;
  if (!isId(userId) || userId === selfId || ownUpload !== false) return;
  return milkyUploadedFile(selfId, userId, { user_id: userId }, value.data, call, uploadCall);
}

export function milkyGroupFileUpload(value: unknown, selfId: number, call: MilkyCall): MessageEvent | undefined {
  if (!isId(selfId) || !isRecord(value) || value.event_type !== "group_file_upload" || value.self_id !== selfId ||
      !isRecord(value.data)) return;
  const { user_id: userId, group_id: groupId } = value.data;
  if (!isId(userId) || userId === selfId || !isId(groupId)) return;
  return milkyUploadedFile(selfId, userId, { group_id: groupId }, value.data, call);
}

function milkyUploadedFile(selfId: number, userId: number, target: Target, data: Record<string, unknown>,
  call: MilkyCall, uploadCall?: MilkyConfirmedCall): MessageEvent | undefined {
  const file = decodeFile(data, target, call);
  if (!file) return;
  const isGroup = "group_id" in target;
  return {
    post_type: "message", message_type: isGroup ? "group" : "private", sub_type: isGroup ? "normal" : "friend",
    self_id: selfId, user_id: userId, sender: { user_id: userId },
    ...(isGroup && { group_id: target.group_id }),
    msg: "", raw_message: "[file]", message: [file], file,
    attachment: milkyAttachment(file),
    isGroup, isPrivate: !isGroup, isMaster: false, boundAccount: false,
    isFriend: isGroup ? undefined : async () => true,
    uploadFile: uploadCall && uploadToMilky(target, uploadCall),
    canReadAttachments: true,
    reply: replyToMilky(target, call),
  };
}

export function milkyMessage(
  value: unknown, selfId: number, call: MilkyCall, scheduleRecall?: ScheduleRecall, forwardCall?: MilkyCall,
  uploadCall?: MilkyConfirmedCall,
): MessageEvent | undefined {
  if (!isId(selfId) || !isRecord(value) || value.event_type !== "message_receive" || value.self_id !== selfId ||
      !isRecord(value.data)) return;
  const { message_scene: scene, sender_id: userId, peer_id: peerId, message_seq: messageId, segments } = value.data;
  if ((scene !== "group" && scene !== "friend") || !isId(userId) || userId === selfId || !isId(peerId) ||
      (scene === "friend" && peerId !== userId) || !isSequence(messageId)) return;
  const isGroup = scene === "group";
  const target = isGroup ? { group_id: peerId } : { user_id: peerId };
  const incoming = decodeSegments(segments, selfId, target, call);
  if (!incoming) return;
  const files = incoming.message.filter(({ type }) => type === "file");
  const quotedSequence = segmentNumber(incoming.replyId);
  let quoted: Promise<QuotedMessage | undefined> | undefined;
  async function lookupQuote(sequence: number, active?: AbortSignal): Promise<QuotedMessage | undefined> {
    try {
      const result = await call("get_message", { message_scene: scene, peer_id: peerId, message_seq: sequence });
      const message = result?.message;
      if (!isRecord(message) || message.message_scene !== scene || message.peer_id !== peerId ||
          message.message_seq !== sequence || !isId(message.sender_id)) return;
      if (!isGroup && message.sender_id !== userId && message.sender_id !== selfId) return;
      const decoded = decodeSegments(message.segments, selfId, target, call);
      if (!decoded || active?.aborted) return;
      const first = decoded.message[0];
      const attachment = active && first?.type === "file" ? milkyAttachment(first) : undefined;
      return { user_id: message.sender_id, message: decoded.message, ...(attachment ? { attachment } : {}) };
    } catch {
      return undefined;
    }
  }
  const action = isGroup ? "send_group_message" : "send_private_message";
  return {
    post_type: "message",
    inlineImageByteLimit: maxPublicFileBytes,
    message_type: isGroup ? "group" : "private",
    sub_type: isGroup ? "normal" : "friend",
    self_id: selfId, user_id: userId, group_id: isGroup ? peerId : undefined, message_id: messageId,
    ...senderMetadata(value.data, isGroup ? peerId : undefined, userId),
    msg: incoming.text.trim(), raw_message: incoming.raw, message: incoming.message,
    atBot: incoming.atBot, at: incoming.at, reply_id: incoming.replyId, img: incoming.img,
    lookupReply: isSequence(quotedSequence) ? () => quoted ??= lookupQuote(quotedSequence) : undefined,
    lookupMediaReply: isSequence(quotedSequence) ? active => lookupQuote(quotedSequence, active) : undefined,
    file: files[0],
    attachment: files.length === 1 ? milkyAttachment(files[0]) : undefined,
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
    forward: forwardCall && (async (nodes, senderName, options) => {
      const messages = encodeMilkyForward(nodes, selfId, senderName);
      if (!messages) return false;
      const result = await forwardCall(action, { ...target, message: [{ type: "forward", data: { messages } }] });
      if (result === undefined) return false;
      if (!isSequence(result?.message_seq)) throw new Error("Milky 合并转发结果未确认。");
      const seconds = replyRecallSeconds(options?.recallMsg);
      if (seconds !== undefined) scheduleRecall?.(isGroup ? "recall_group_message" : "recall_private_message", { ...target, message_seq: result.message_seq }, seconds);
      return true;
    }),
    uploadFile: uploadCall && uploadToMilky(target, uploadCall),
    [sendSessionMedia]: uploadCall && forwardCall && (async (url, name, type) => {
      if (type === "file") return uploadMilkyFile(target, uploadCall, url, name);
      try {
        const result = await forwardCall(action, { ...target, message: [{ type, data: { uri: url } }] });
        if (!result) return "rejected";
        return isSequence(result.message_seq) ? "confirmed" : "unknown";
      } catch {
        return "unknown";
      }
    }),
    canReadAttachments: true,
    reply: replyToMilky(target, call, { messageId, groupSender: isGroup ? userId : undefined, scheduleRecall }),
  };
}
