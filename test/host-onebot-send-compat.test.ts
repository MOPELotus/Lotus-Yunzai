import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("V3 OneBot 普通回包保留消息段和目标，只降级按钮", async () => {
  await withDualGatewayFixture("onebot-v3-send-fixture", "disablePrivate: false\n", async ({ sendOneBot, onebot }) => {
    const group = { message_type: "group", sub_type: "normal", group_id: 707 };
    sendOneBot("#旧普通回包", group);
    const message = await onebot.next("send_msg");
    expect(message.echo).toBeUndefined();
    expect(message.params).toEqual({ message_type: "group", group_id: 707, auto_escape: true, message: [
      { type: "text", data: { text: "保留正文" } },
      { type: "at", data: { qq: "42" } }, { type: "at", data: { qq: "all" } },
      { type: "reply", data: { id: "-135" } },
      { type: "image", data: { file: "base64://AQID", sub_type: 1 } },
      { type: "record", data: { file: "base64://BAU=" } },
      { type: "video", data: { file: "https://example.invalid/media.mp4" } },
    ] });

    sendOneBot("#旧私聊正文", { message_type: "private", sub_type: "friend" });
    const direct = await onebot.next("send_msg");
    expect(direct.params).toEqual({ message_type: "private", user_id: 42, auto_escape: true, message: "[CQ:at,qq=42]" });

    sendOneBot("#旧仅按钮", group);
    const button = await onebot.next("send_msg");
    expect(button.params).toMatchObject({ group_id: 707, message: "没有可发送的消息段" });

    sendOneBot("#旧原样段", group);
    const raw = await onebot.next("send_msg");
    expect(raw.params).toMatchObject({ group_id: 707, message: "原样段不可发送" });
  }, 3_000, undefined, async root => {
    await writeFile(join(root, "plugins", "onebot-send-fixture.js"), `
      export default class extends plugin {
        constructor() {
          super({ rule: [
            { reg: "^#旧普通回包$", fnc: "replyAll" },
            { reg: "^#旧私聊正文$", fnc: "plain" },
            { reg: "^#旧仅按钮$", fnc: "button" },
            { reg: "^#旧原样段$", fnc: "raw" },
          ] });
        }
        replyAll(e) {
          return e.reply([
            { type: "button", data: [] },
            "保留正文", segment.at(42), { type: "at", data: { qq: "all" } },
            { type: "reply", id: -135 },
            { type: "image", file: Uint8Array.of(9, 1, 2, 3, 9).subarray(1, 4), sub_type: 1 },
            segment.record(Uint8Array.of(4, 5)), segment.video("https://example.invalid/media.mp4"),
          ], true);
        }
        plain(e) { return e.reply("[CQ:at,qq=42]"); }
        async button(e) {
          if (!await e.reply({ type: "button", data: [] }, true)) return e.reply("没有可发送的消息段");
        }
        async raw(e) {
          if (!await e.reply(["不应送出", { type: "raw", data: { type: "text", data: { text: "原样段" } } }])) {
            return e.reply("原样段不可发送");
          }
        }
      }
    `);
  });
}, 8_000);
