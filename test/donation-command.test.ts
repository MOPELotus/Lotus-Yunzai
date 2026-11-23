import { expect, test } from "bun:test";
import { CommandRegistry, type CommandModule } from "../lib/commands.ts";
import { donationCommands } from "../lib/donation-command.ts";
import type { MessageReply } from "../lib/messages.ts";

const url = "https://www.lotusshared.cn/donate";

function invoke(module: CommandModule, reply: (message: MessageReply) => boolean, message = "#捐赠") {
  const registry = new CommandRegistry();
  registry.registerModule(module);
  return registry.dispatchFallback({
    msg: message, raw_message: message, message, post_type: "message", message_type: "group",
    isGroup: true, isPrivate: false, isMaster: false, self_id: 99, user_id: 42, group_id: 77, reply,
  }, () => true, () => false);
}

test("普通群员使用原捐赠别名，配置海报后按原顺序出图并延迟发送链接", async () => {
  const messages: MessageReply[] = [];
  const signal = new AbortController().signal;
  const reply = (message: MessageReply) => { messages.push(message); return true; };
  const png = Buffer.from([1, 2, 3]);
  const render = async () => ({ png });
  expect(await invoke(donationCommands(signal, "", render), reply)).toBe(url);
  expect(messages).toEqual([]);
  const configured = donationCommands(signal, "fixture-posters", render, async () => { messages.push("pause"); });
  expect(await invoke(configured, reply, "#Donate")).toBe(url);
  expect(messages).toEqual([{ type: "image", file: png }, "pause"]);
  expect(await invoke(configured, reply, "#Donate invalid")).toBeUndefined();
});

test("捐赠图渲染失败和网关拒绝均保留链接，停机不继续回复", async () => {
  const messages: MessageReply[] = [];
  const lifetime = new AbortController();
  const reply = (message: MessageReply) => { messages.push(message); return false; };
  const broken = donationCommands(lifetime.signal, "fixture-posters", async () => { throw new Error("image unavailable"); }, async () => {});
  expect(await invoke(broken, reply)).toBe(url);
  expect(messages.splice(0)).toEqual(["捐赠图片生成失败，请通过稍后发送的链接查看。"]);
  const png = Buffer.from([1, 2, 3]);
  const rejected = donationCommands(lifetime.signal, "fixture-posters", async () => ({ png }), async () => { lifetime.abort(); });
  expect(await invoke(rejected, reply)).toEqual([]);
  expect(messages).toEqual([{ type: "image", file: png }, "捐赠图片发送失败，请通过稍后发送的链接查看。"]);
});
