import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import type { FileToUrl } from "./file-to-url.ts";
import type { MessageReply } from "./messages.ts";

const mediaLabels = new Map([
  ["image", $t("lib.terminal-reply.text_d24c10d37d")],
  ["record", $t("lib.terminal-reply.text_296c632ec8")],
  ["video", $t("lib.terminal-reply.text_c20f7618d3")],
  ["file", $t("lib.terminal-reply.text_39932f24fe")],
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
