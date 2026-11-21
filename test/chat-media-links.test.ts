import { expect, spyOn, test } from "bun:test";
import { createChatMediaLinks } from "../lib/chat-media-links.ts";
import { delegationSession, type DelegationSession } from "../lib/command-delegation.ts";
import { createFileToUrl } from "../lib/file-to-url.ts";
import type { MessageEvent } from "../lib/messages.ts";
import { createPublicFiles } from "../lib/public-files.ts";

test("取直链只发布同一会话文件的字节，六十秒后旧 File 路由不可取", async () => {
  const clock = spyOn(performance, "now").mockReturnValue(100);
  const files = createPublicFiles();
  try {
    const base = new URL("http://127.0.0.1:12340/");
    const signal = new AbortController().signal;
    const read = createChatMediaLinks(createFileToUrl(files, {}, () => base), () => true);
    const fixture = Uint8Array.of(1, 2, 3);
    let link: string | undefined;
    let reads = 0;
    const event: MessageEvent = {
      msg: "#取直链", raw_message: "#取直链", message: [], post_type: "message",
      message_type: "private", sub_type: "friend", self_id: 99, user_id: 42,
      isPrivate: true, isGroup: false, isMaster: false,
      canReadAttachments: true, attachment: { name: "样本.txt", async read() { reads++; return fixture; } },
      [delegationSession]: { signal } as DelegationSession,
      reply(body) { if (typeof body === "string") link = body.split("\n").at(1); return true; },
    };
    expect(await read({ ...event, isDelegated: true }, () => signal, true, () => true)).toBe(true);
    expect(reads).toBe(0);
    expect(await read(event, () => signal, true, () => true)).toBe(true);
    expect(reads).toBe(1);
    expect(link).toMatch(/\/File\/[a-f0-9-]{36}$/u);
    clock.mockReturnValue(60_099);
    const current = files.handle(new Request(link!));
    expect(current?.status).toBe(200);
    expect(new Uint8Array(await current!.arrayBuffer())).toEqual(fixture);
    clock.mockReturnValue(60_100);
    expect(files.handle(new Request(link!))?.status).toBe(404);
  } finally {
    clock.mockRestore();
    files.close();
  }
});
