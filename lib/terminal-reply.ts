import type { FileToUrl } from "./file-to-url.ts";
import type { MessageReply } from "./messages.ts";

const mediaLabels = new Map([
  ["image", "图片"],
  ["record", "音频"],
  ["video", "视频"],
  ["file", "文件"],
]);

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function createTerminalReply(fileToUrl: FileToUrl, output: (text: string) => void) {
  async function render(parts: readonly unknown[]): Promise<boolean> {
    const lines: string[] = [];
    for (const part of parts) {
      if (typeof part === "string") {
        lines.push(part);
        continue;
      }
      const segment = object(part);
      if (typeof segment?.type !== "string") continue;
      const data = object(segment.data) ?? segment;
      if (segment.type === "text" && typeof data.text === "string") {
        lines.push(data.text);
        continue;
      }
      const label = mediaLabels.get(segment.type);
      const file = data.file;
      if (!label || (typeof file !== "string" && !(file instanceof Uint8Array) && !(file instanceof Blob))) continue;
      try {
        const name = typeof data.name === "string" ? data.name : undefined;
        lines.push(`${label} ${await fileToUrl(file, { name })}`);
      } catch {
        // Leave unsupported media to the caller's usual fallback.
      }
    }
    if (!lines.length) return false;
    output(lines.join("\n"));
    return true;
  }

  return (reply: MessageReply): boolean | Promise<boolean> => {
    if (typeof reply === "string") {
      output(reply);
      return true;
    }
    return render(Array.isArray(reply) ? reply : [reply]);
  };
}
