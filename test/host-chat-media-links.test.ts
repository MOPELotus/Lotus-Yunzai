import { expect, test } from "bun:test";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const sample = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const image = "https://gchat.qpic.cn/gchatpic_new/fixture-image/0?rkey=image-fixture-key";
const expired = "https://gchat.qpic.cn/download?rkey=stale-fixture-key";
const renewed = "https://multimedia.nt.qq.com.cn/download?rkey=fresh-fixture-key";
const fileUrl = "https://grouptalk.c2c.qq.com/fixture-download?key=file-fixture-key";
const fileId = "/a964668d-13c2-49c9-9c7e-aa8355658559";
const fileName = "会话样本.json";
const fileBytes = "{}\n";

const preload = `
const real = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, options) => {
  const value = input instanceof Request ? input.url : String(input);
  if (value === ${JSON.stringify(expired)}) return new Response("", { status: 404 });
  if (value === ${JSON.stringify(image)} || value === ${JSON.stringify(renewed)}) {
    if (options?.redirect !== "error" || options?.credentials !== "omit") throw new Error("请求不符合 QQ 图片边界");
    return new Response(Buffer.from(${JSON.stringify(sample)}, "base64"), { headers: { "content-type": "image/png" } });
  }
  if (value === ${JSON.stringify(fileUrl)}) return new Response(${JSON.stringify(fileBytes)});
  if (new URL(value).hostname === "127.0.0.1") return real(input, options);
  throw new Error("非预期网络请求");
}, { preconnect: real.preconnect });
`;

function issued(value: unknown) {
  const body = JSON.stringify(value);
  expect(body).not.toContain("fixture-key");
  return [...new Set(body.match(/http:\/\/127\.0\.0\.1:\d+\/File\/[a-f0-9-]{36}/gu))];
}

async function readImage(link: string) {
  const response = await fetch(link);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(sample);
}

test("取直链以当前或同会话图片和附件生成公开 HTTP 临时字节副本", async () => {
  await withDualGatewayFixture("chat-links-fixture", "disablePrivate: false\n",
    async ({ milky, onebot, sendOneBot, sendMilky }) => {
      const photo = { type: "image", data: { url: image } };
      const quote = (id: number, text = "#获取直链") => [
        { type: "reply", data: { id } }, { type: "text", data: { text } },
      ];
      const group = { message_type: "group", sub_type: "normal", group_id: 707 };
      sendOneBot("#取直链", { message: [{ type: "text", data: { text: "#取直链" } }, photo] });
      expect((await onebot.next("send_msg")).params).toMatchObject({ user_id: 42, message: "✅ 检测到1张图片" });
      const generated = await onebot.next("send_msg");
      const [single] = issued(generated.params);
      expect(single).toBeDefined();
      expect(generated.params).toMatchObject({ user_id: 42, message: [
        { type: "image", data: { file: single } }, { type: "text", data: { text: "\n" } }, { type: "text", data: { text: single } },
      ] });
      await readImage(single!);

      sendOneBot("#获取直链", { ...group, message: quote(900) });
      (await onebot.next("get_msg")).respond({
        self_id: 99, group_id: 707, message_type: "group", message_id: 900, sender: { user_id: 61 }, message: [photo, photo],
      });
      expect((await onebot.next("send_msg")).params).toMatchObject({ group_id: 707, message: "✅ 检测到2张图片" });
      const forwarded = await onebot.next("send_group_forward_msg");
      expect(forwarded.params).toMatchObject({ group_id: 707 });
      const two = issued(forwarded.params);
      expect(two).toHaveLength(2);
      forwarded.respond({ message_id: -91 });
      await Promise.all(two.map(readImage));

      sendOneBot("#获取直链", { ...group, message: quote(901, "#取直链") });
      (await onebot.next("get_msg")).respond({
        self_id: 99, group_id: 708, message_type: "group", message_id: 901, sender: { user_id: 61 }, message: [photo],
      });
      expect((await onebot.next("send_msg")).params).toMatchObject({ group_id: 707,
        message: [{ type: "reply" }, { type: "text", data: { text: "无法读取当前会话的引用消息。" } }],
      });

      sendOneBot("#获取直链", { message: quote(902) });
      (await onebot.next("get_msg")).respond({
        self_id: 99, user_id: 42, message_type: "private", sub_type: "friend", message_id: 902, target_id: 99,
        sender: { user_id: 42 }, message: [{ type: "file", data: { file: fileName, file_id: fileId, file_size: fileBytes.length } }],
      });
      const privateDownload = await onebot.next("get_private_file_url");
      expect(privateDownload.params).toEqual({ file_id: fileId });
      privateDownload.respond({ url: fileUrl });
      const privateFile = await onebot.next("send_msg");
      const [privateLink] = issued(privateFile.params);
      expect(await (await fetch(privateLink!)).text()).toBe(fileBytes);

      await sendMilky("#取直链", { message_scene: "group", peer_id: 800, segments: [
        { type: "reply", data: { message_seq: 870 } }, { type: "text", data: { text: "#取直链" } },
      ] });
      const source = await milky.next("get_message");
      expect(source.params).toEqual({ message_scene: "group", peer_id: 800, message_seq: 870 });
      source.respond({ message: { message_scene: "group", peer_id: 800, sender_id: 61, message_seq: 870, segments: [
        { type: "file", data: { file_id: fileId, file_name: fileName, file_size: fileBytes.length } },
      ] } });
      const download = await milky.next("get_group_file_download_url");
      expect(download.params).toEqual({ group_id: 800, file_id: fileId });
      download.respond({ download_url: fileUrl });
      const attachment = await milky.next("send_group_message");
      const [link] = issued(attachment.params);
      expect(attachment.params).toMatchObject({ group_id: 800,
        message: [{ type: "reply" }, { type: "text", data: { text: `下载链接:\n${link}` } }],
      });
      attachment.respond({ message_seq: 301 });
      const response = await fetch(link!);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toStartWith("attachment;");
      expect(await response.text()).toBe(fileBytes);

      await sendMilky("#取直链", { segments: [
        { type: "reply", data: { message_seq: 871 } }, { type: "text", data: { text: "#取直链" } },
      ] });
      (await milky.next("get_message")).respond({ message: { message_scene: "friend", peer_id: 43, sender_id: 43, message_seq: 871,
        segments: [{ type: "file", data: { file_id: fileId, file_name: fileName, file_size: fileBytes.length } }],
      } });
      const denied = await milky.next("send_private_message");
      expect(denied.params).toMatchObject({ user_id: 43,
        message: [{ type: "reply" }, { type: "text", data: { text: "无法读取当前会话的附件。" } }],
      });
      denied.respond({ message_seq: 302 });

      await sendMilky("#获取直链");
      const ask = await milky.next("send_private_message");
      expect(ask.params).toMatchObject({ user_id: 43, message: [{ data: { text: "⚠ 请发送图片" } }] });
      ask.respond({ message_seq: 303 });
      const next = [{ type: "image", data: { temp_url: expired, resource_id: "image-fixture" } }];
      await sendMilky("", { sender_id: 44, peer_id: 44, segments: next });
      await Bun.sleep(70);
      expect(milky.calls).toEqual([]);
      await sendMilky("文字");
      const retry = await milky.next("send_private_message");
      expect(retry.params).toMatchObject({ user_id: 43, message: [{ data: { text: "⚠ 请发送图片或取消" } }] });
      retry.respond({ message_seq: 304 });
      await sendMilky("", { segments: next });
      const refresh = await milky.next("get_resource_temp_url");
      expect(refresh.params).toEqual({ resource_id: "image-fixture" });
      refresh.respond({ url: renewed });
      const followed = await milky.next("send_private_message");
      const [followedLink] = issued(followed.params);
      expect(followed.params).toMatchObject({ user_id: 43, message: [{ type: "text", data: { text: followedLink } }] });
      followed.respond({ message_seq: 305 });
      await readImage(followedLink!);

      sendOneBot("#取直链", { ...group, message: [
        { type: "text", data: { text: "#取直链" } }, { type: "image", data: { url: "file:///etc/passwd" } },
      ] });
      expect((await onebot.next("send_msg")).params).toMatchObject({ group_id: 707,
        message: [{ type: "reply" }, { type: "text", data: { text: "无法读取当前会话的图片或图片过大。" } }],
      });
      sendOneBot("#取直链", { ...group, group_id: 709 });
      expect((await onebot.next("send_msg")).params).toMatchObject({ group_id: 709, message: "⚠ 请发送图片" });
      sendOneBot("取消", { ...group, group_id: 709 });
      expect((await onebot.next("send_msg")).params).toMatchObject({ group_id: 709, message: "✅ 已取消" });
      sendOneBot("", { ...group, group_id: 709, message: [photo] });
      await Bun.sleep(70);
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    }, 3_000, preload);
}, 12_000);
