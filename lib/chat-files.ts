export interface ChatFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export type ChatFileResult = "confirmed" | "rejected" | "unknown";

export const maxChatFileBytes = 16 * 1024 * 1024;

export function encodeChatFile({ name, bytes }: ChatFile): string | undefined {
  if (typeof name !== "string" || !(bytes instanceof Uint8Array)) return;
  if (!name.trim() || name === "." || name === ".." || /[/\\\u0000-\u001f\u007f]/u.test(name) ||
      Buffer.byteLength(name) > 255 || !bytes.byteLength || bytes.byteLength > maxChatFileBytes) return;
  return `base64://${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")}`;
}
