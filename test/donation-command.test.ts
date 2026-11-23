import { expect, test } from "bun:test";
import type { CommandContext } from "../lib/commands.ts";
import { donationCommands } from "../lib/donation-command.ts";
import type { MessageReply } from "../lib/messages.ts";

const url = "https://www.lotusshared.cn/donate";

test("捐赠默认只给公开链接，配置海报后保留出图和延迟链接顺序", async () => {
  const messages: (MessageReply | "pause")[] = [];
  const signal = new AbortController().signal;
  const context: CommandContext = { message_type: "private", isMaster: false, reply(message) { messages.push(message); return true; } };
  const png = Buffer.from([1, 2, 3]);
  const render = async () => ({ png });
  const unconfigured = donationCommands(signal, "", render).commands["#捐赠"]!;
  expect(await unconfigured("", context)).toBe(url);
  expect(messages).toEqual([]);
  const configured = donationCommands(signal, "fixture-posters", render, async () => { messages.push("pause"); });
  expect(await configured.commands["#捐赠"]!("", context)).toBe(url);
  expect(messages).toEqual([{ type: "image", file: png }, "pause"]);
  expect(configured.aliases?.["#Donate"]).toBe("#捐赠");
});

test("捐赠图渲染失败和网关拒绝均保留链接，停机不继续回复", async () => {
  const messages: MessageReply[] = [];
  const lifetime = new AbortController();
  const context: CommandContext = { message_type: "group", isMaster: false, reply(message) { messages.push(message); return false; } };
  const broken = donationCommands(lifetime.signal, "fixture-posters", async () => { throw new Error("image unavailable"); }, async () => {});
  expect(await broken.commands["#捐赠"]!("", context)).toBe(url);
  expect(messages.splice(0)).toEqual(["捐赠图片生成失败，请通过稍后发送的链接查看。"]);
  const png = Buffer.from([1, 2, 3]);
  const rejected = donationCommands(lifetime.signal, "fixture-posters", async () => ({ png }),
    async () => { lifetime.abort(); });
  expect(await rejected.commands["#捐赠"]!("", context)).toEqual([]);
  expect(messages).toEqual([{ type: "image", file: png }, "捐赠图片发送失败，请通过稍后发送的链接查看。"]);
});
