import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const token = "owner-relay-fixture";
const time = 1_700_000_000;
const image = "https://gchat.qpic.cn/download?relay-fixture";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kds0AAAAASUVORK5CYII=";
const audio = "https://multimedia.nt.qq.com.cn/record?relay-fixture";
const video = "https://multimedia.nt.qq.com.cn/video?relay-fixture";
const file = "https://multimedia.nt.qq.com.cn/file?relay-fixture";
const fixtures = {
  [image]: ["image/png", png],
  [audio]: ["audio/wav", "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="],
  [video]: ["video/mp4", "AAAAFGZ0eXBpc29tAAAAAGlzb20AAAAIbWRhdA=="],
  [file]: ["application/octet-stream", Buffer.from("附件原字节").toString("base64")],
} as const;
type Call = { action: string; params: Record<string, unknown>; echo?: string };

async function endpoints(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    for (;;) {
      const ws = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
      const http = /http:\/\/127\.0\.0\.1:\d+\/status/u.exec(output)?.[0];
      if (http && ws) return { ws, webhook: new URL("/milky", http) };
      const chunk = await reader.read();
      if (chunk.done) throw new Error(output);
      output += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function next(calls: Call[], action: string, seconds = 2) {
  const limit = performance.now() + seconds * 1_000;
  while (!calls.length && performance.now() < limit) await Bun.sleep(10);
  if (!calls.length) throw new Error(`未收到模拟网关动作 ${action}`);
  const call = calls.shift()!;
  expect(call.action).toBe(action);
  return call.params;
}

test("真实双协议宿主发送、取消、跨授权账号及编号群名单不漂移", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-owner-relay-"));
  const oneBotCalls: Call[] = [];
  const milkyCalls: Call[] = [];
  const attachmentReads: Call[] = [];
  let groupOrder = [771, 772];
  let unknownGroup = 0;
  let rejectedGroup = 0;
  let unknownUpload = false;
  let blockMilkyGroupLookup: { requested: ReturnType<typeof Promise.withResolvers<void>>;
    resume: ReturnType<typeof Promise.withResolvers<void>> } | undefined;
  const gateway = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      const action = new URL(request.url).pathname.split("/").at(-1)!;
      if (action === "get_login_info") return Response.json({ status: "ok", retcode: 0, data: { uin: 100 } });
      const params = await request.json() as Call["params"];
      if (action === "get_friend_list") return Response.json({ status: "ok", retcode: 0, data: { friends: [{ user_id: 781 }] } });
      if (action === "get_private_file_download_url") {
        attachmentReads.push({ action, params });
        return Response.json({ status: "ok", retcode: 0, data: { download_url: file } });
      }
      if (action === "get_group_list") {
        const blocked = blockMilkyGroupLookup;
        if (blocked) {
          blocked.requested.resolve();
          await blocked.resume.promise;
        }
        return Response.json({ status: "ok", retcode: 0, data: { groups: [{ group_id: 773 }] } });
      }
      milkyCalls.push({ action, params });
      if (action === "upload_group_file") {
        return Response.json({ status: "ok", retcode: 0, data: { file_id: "destination-upload-id" } });
      }
      return Response.json({ status: "ok", retcode: 0, data: { message_seq: 300 } });
    },
  });
  try {
    await copyHost(root);
    await mkdir(join(root, "config"), { recursive: true });
    const ownerConfig = join(root, "config", "other.yaml");
    const owners = 'master: ["99:42", "100:42", "100:43"]\n';
    await writeFile(ownerConfig, owners);
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${gateway.port}`, "connection: webhook", `access_token: ${token}`, "",
    ].join("\n"));
    const preload = join(root, "fixture.ts");
    await writeFile(preload, `
      const actual = globalThis.fetch;
      globalThis.fetch = (input, options) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const fixture = ${JSON.stringify(fixtures)}[url.href];
        if (fixture) {
          return Promise.resolve(new Response(Buffer.from(fixture[1], "base64"), {
            headers: { "content-type": fixture[0] }
          }));
        }
        if (url.hostname !== "127.0.0.1") throw new Error("unexpected network");
        return actual(input, options);
      };
    `);
    disableMemberPrewarm(root);
    const host = Bun.spawn([process.execPath, "--preload", preload, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
    let socket: WebSocket | undefined;
    const stderr = new Response(host.stderr).text();
    try {
      const url = await endpoints(host.stdout);
      const connect = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
      const ws = socket = new connect(url.ws, { headers: {
        Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": "99",
      } });
      const open = Promise.withResolvers<void>();
      ws.addEventListener("open", () => open.resolve(), { once: true });
      ws.addEventListener("error", () => open.reject(new Error("OneBot 模拟网关未连接")), { once: true });
      ws.addEventListener("message", ({ data }) => {
        const call = JSON.parse(data) as Call;
        let result: unknown = { message_id: 200 };
        if (call.action === "get_friend_list") result = [{ user_id: 780 }];
        else if (call.action === "get_group_list") result = groupOrder.map(group_id => ({ group_id, group_name: `群${group_id}` }));
        else if (call.action === "get_private_file_url") {
          attachmentReads.push(call);
          result = { url: file };
        }
        else {
          oneBotCalls.push(call);
          if (call.action === "upload_private_file") result = unknownUpload ? {} : { file_id: "destination-upload-id" };
          if (call.params.group_id === unknownGroup) result = {};
        }
        const rejected = call.params.group_id === rejectedGroup;
        ws.send(JSON.stringify({ echo: call.echo, status: rejected ? "failed" : "ok", retcode: rejected ? 1200 : 0, data: result }));
      });
      await open.promise;
      function webhook(event: object) {
        return fetch(url.webhook, { method: "POST", headers: {
          Authorization: `Bearer ${token}`, "Content-Type": "application/json",
        }, body: JSON.stringify(event), signal: AbortSignal.timeout(2_000) });
      }
      for (let attempt = 0; ; attempt++) {
        const response = await webhook({ event_type: "fixture", self_id: 100, time, data: {} });
        if (response.status === 200) break;
        if (response.status !== 503 || attempt >= 25) throw new Error("Milky 模拟网关未连接");
        await Bun.sleep(20);
      }
      let sequence = 0;
      function sendOneBot(message: unknown, fields: object = {}) {
        const message_id = ++sequence;
        ws.send(JSON.stringify({ post_type: "message", message_type: "private", sub_type: "friend", message_id,
          self_id: 99, user_id: 42, time, message, ...fields }));
        return message_id;
      }
      function sendMilky(text: string, fields: object = {}, self_id = 100) {
        return webhook({ event_type: "message_receive", self_id, time, data: {
          message_scene: "friend", sender_id: 43, peer_id: 43, time, message_seq: ++sequence,
          segments: [{ type: "text", data: { text } }], ...fields,
        } });
      }
      const oneBotReply = async (message: string, user_id = 42) =>
        expect(await next(oneBotCalls, "send_msg")).toMatchObject({ user_id, message });
      const milkyReply = async (text: string, user_id = 43) => expect(await next(milkyCalls, "send_private_message")).toMatchObject({
        user_id, message: [{ type: "text", data: { text } }],
      });
      async function silence() {
        await Bun.sleep(100);
        expect(oneBotCalls).toEqual([]);
        expect(milkyCalls).toEqual([]);
      }

      sendOneBot("#发好友780 旧连写正文");
      await oneBotReply("旧连写正文", 780);
      await oneBotReply("780 的私聊消息已送达。");
      sendOneBot([{ type: "text", data: { text: "#发好友 780 图片" } }, { type: "image", data: { url: image } }]);
      expect(await next(oneBotCalls, "send_msg")).toMatchObject({ user_id: 780, message: [
        { type: "text", data: { text: "图片" } }, { type: "image", data: { file: `base64://${png}` } },
      ] });
      await oneBotReply("780 的私聊消息已送达。");
      sendOneBot("#发好友 780 authkey=synthetic");
      await oneBotReply("已停止发送，请勿转发登录凭据。");
      sendOneBot([
        { type: "text", data: { text: "#发好友780 原语音" } }, { type: "record", data: { file: "original-voice-id", url: audio } },
      ]);
      expect(await next(oneBotCalls, "send_msg")).toMatchObject({ user_id: 780, message: [
        { type: "text", data: { text: "原语音" } },
        { type: "record", data: { file: `base64://${fixtures[audio][1]}` } },
      ] });
      await oneBotReply("780 的私聊消息已送达。");
      const oneBotFile = { type: "file", data: { file: "原件.dat", file_id: "old-source-file",
        file_size: Buffer.from(fixtures[file][1], "base64").byteLength } };
      sendOneBot([{ type: "text", data: { text: "#发好友780" } }, oneBotFile]);
      expect(await next(oneBotCalls, "upload_private_file")).toEqual({
        user_id: 780, name: "原件.dat", file: `base64://${fixtures[file][1]}`,
      });
      await oneBotReply("780 的私聊消息已送达。");
      expect(await next(attachmentReads, "get_private_file_url")).toEqual({ file_id: "old-source-file" });
      sendOneBot([{ type: "text", data: { text: "#发好友780 文件与文字" } }, oneBotFile]);
      await oneBotReply("文件须单独发送，本次含其他内容的代发未发出。");
      sendOneBot([{ type: "reply", data: { id: "70" } }, { type: "text", data: { text: "#发好友 780 带引用" } }]);
      await oneBotReply("引用属于来源会话。请直接发送正文或原件，本次代发未发出。");
      expect(attachmentReads).toEqual([]);
      unknownUpload = true;
      sendOneBot([{ type: "text", data: { text: "#发好友 780" } }, oneBotFile]);
      expect(await next(oneBotCalls, "upload_private_file")).toMatchObject({ user_id: 780 });
      await oneBotReply("780 的发送结果未确认，请先核对原会话。");
      await next(attachmentReads, "get_private_file_url");
      unknownUpload = false;
      sendOneBot("#发好友 999 不存在");
      await oneBotReply("当前发送账号的名单中没有这个目标。");
      sendOneBot("#发好友 780 禁止群临时发送", { sub_type: "group" });
      sendOneBot("#发好友 780 错误主人", { user_id: 43 });
      await sendMilky("#发好友 781 错误账号", {}, 99);
      await silence();

      await sendMilky("#发好友781");
      await milkyReply("请发送需要发送的消息，或发送 #取消。");
      await sendMilky("#取消");
      await milkyReply("已取消发送。");
      await sendMilky("取消后的正文");
      await silence();

      await sendMilky("#发群聊 773");
      await milkyReply("请发送需要发送的消息，或发送 #取消。");
      await sendMilky("不是原会话", { sender_id: 42, peer_id: 42 });
      await silence();
      await sendMilky("", { segments: [
        { type: "text", data: { text: "续问正文" } }, { type: "face", data: { face_id: "14" } },
      ] });
      expect(await next(milkyCalls, "send_group_message")).toMatchObject({ group_id: 773, message: [
        { type: "text", data: { text: "续问正文" } }, { type: "face", data: { face_id: "14" } },
      ] });
      await milkyReply("773 的群聊消息已送达。");
      await sendMilky("", { segments: [
        { type: "text", data: { text: "#发群聊773 原视频" } }, { type: "video", data: { temp_url: video } },
      ] });
      expect(await next(milkyCalls, "send_group_message")).toMatchObject({ group_id: 773, message: [
        { type: "text", data: { text: "原视频" } },
        { type: "video", data: { uri: `base64://${fixtures[video][1]}` } },
      ] });
      await milkyReply("773 的群聊消息已送达。");
      await sendMilky("", { segments: [
        { type: "text", data: { text: "#发群聊773 混合坏段" } },
        { type: "video", data: { temp_url: "https://example.invalid/denied-video" } },
      ] });
      await milkyReply("无法读取或发送这种消息内容。");
      await sendMilky("", { segments: [
        { type: "text", data: { text: "#发群聊773" } },
        { type: "file", data: { file_name: "原附件.dat", file_id: "milky-source-id", file_hash: "source-hash",
          file_size: Buffer.from(fixtures[file][1], "base64").byteLength } },
      ] });
      expect(await next(milkyCalls, "upload_group_file")).toEqual({
        group_id: 773, parent_folder_id: "/", file_name: "原附件.dat", file_uri: `base64://${fixtures[file][1]}`,
      });
      await milkyReply("773 的群聊消息已送达。");
      expect(await next(attachmentReads, "get_private_file_download_url")).toEqual({
        user_id: 43, file_id: "milky-source-id", file_hash: "source-hash",
      });

      await sendMilky("#99发好友780 没有这台机器人授权");
      await milkyReply("未能确认发送账号及主人权限。");
      sendOneBot("#100 发群聊773 指定机器人");
      expect(await next(milkyCalls, "send_group_message")).toMatchObject({ group_id: 773,
        message: [{ type: "text", data: { text: "指定机器人" } }],
      });
      await oneBotReply("773 的群聊消息已送达。");
      const blocked = blockMilkyGroupLookup = { requested: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() };
      sendOneBot("#100发群聊773 等候名单时撤销授权");
      await Promise.race([blocked.requested.promise, Bun.sleep(1_000).then(() => { throw new Error("未查询目标账号名单"); })]);
      await writeFile(ownerConfig, owners.replace('"100:42", ', ""));
      await Bun.sleep(1_100);
      blockMilkyGroupLookup = undefined;
      blocked.resume.resolve();
      await silence();
      sendOneBot("#100发群聊773 已撤销的授权");
      await oneBotReply("未能确认发送账号及主人权限。");

      sendOneBot("#发群列表1 还没查");
      await oneBotReply("请先在当前机器人的主人好友私聊查询 #群列表，再使用序号发送。");
      sendOneBot("#群列表");
      const roster = await next(oneBotCalls, "send_private_forward_msg");
      expect(JSON.stringify(roster)).toContain("1、群771(771)");
      expect(JSON.stringify(roster)).toContain("2、群772(772)");
      groupOrder = [772, 771];
      sendOneBot("#发群列表1,2 固定顺序");
      await oneBotReply("将按已确认的群列表顺序发送，间隔 5 秒。");
      expect(await next(oneBotCalls, "send_msg")).toMatchObject({ group_id: 771, message: "固定顺序" });
      await oneBotReply("771 的群聊消息已送达。");
      expect(await next(oneBotCalls, "send_msg", 7)).toMatchObject({ group_id: 772, message: "固定顺序" });
      await oneBotReply("772 的群聊消息已送达。");

      sendOneBot("#发群列表1，2 分隔符无效");
      await oneBotReply("请指定好友 QQ、群号或不重复的群列表序号（最多 3 个）。");
      groupOrder = [772];
      sendOneBot("#发群列表1 成员已离群");
      await oneBotReply("当前发送账号的名单中没有这个目标。");
      rejectedGroup = 772;
      sendOneBot("#发群聊772 网关明确拒绝");
      expect(await next(oneBotCalls, "send_msg")).toMatchObject({ group_id: 772, message: "网关明确拒绝" });
      await oneBotReply("772 的消息未发出。");
      rejectedGroup = 0;
      unknownGroup = 772;
      const msg = "#发群聊772 网关未确认";
      const original = sendOneBot(msg);
      expect(await next(oneBotCalls, "send_msg")).toMatchObject({ group_id: 772, message: "网关未确认" });
      await oneBotReply("772 的发送结果未确认，请先核对原会话。");
      await Bun.sleep(1_050);
      sendOneBot(msg, { message_id: original });
      await oneBotReply("772 的发送结果未确认，请先核对原会话。");
      await silence();
    } finally {
      socket?.close();
      host.kill();
      await host.exited;
      expect(await stderr).not.toContain("处理 OneBot 事件失败");
    }
  } finally {
    gateway.stop(true);
    await rm(root, { force: true, recursive: true });
  }
}, 18_000);
