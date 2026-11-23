import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const token = "v3-group-notice-fixture";
const oneBotId = 901;
const milkyId = 902;
const groupId = 801;
const userId = 701;
const stamp = 1_700_000_000;

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const end = performance.now() + 4_000;
  do {
    const result = read();
    if (result !== undefined) return result;
    await Bun.sleep(10);
  } while (performance.now() < end);
  throw new Error(label);
}

async function hostReady(stream: ReadableStream<Uint8Array>) {
  let stdout = "";
  for await (const chunk of stream) {
    stdout += new TextDecoder().decode(chunk);
    if (stdout.includes("Lotus-Yunzai 已启动")) {
      const endpoint = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(stdout)?.[0];
      if (endpoint) return endpoint;
    }
  }
  throw new Error("测试宿主未完成启动。\n" + stdout);
}

test("旧群通知经 OneBot 和 Milky WebSocket 交给正确的 V3 插件监听", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-v3-group-notices-"));
  const replies: unknown[] = [];
  let milkySocket: Bun.ServerWebSocket<undefined> | undefined;
  const gateway = Bun.serve<undefined>({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      if (request.headers.get("Authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      const path = new URL(request.url).pathname;
      if (path === "/event" && server.upgrade(request)) return;
      if (path === "/api/get_login_info") {
        return Response.json({ status: "ok", retcode: 0, data: { uin: milkyId, nickname: "测试机器人" } });
      }
      if (path === "/api/send_group_message") {
        const { group_id, message } = await request.json();
        replies.push({ group_id, payload: JSON.parse(message[0].data.text) });
        return Response.json({ status: "ok", retcode: 0, data: { message_seq: replies.length, time: stamp } });
      }
      return new Response(null, { status: 404 });
    },
    websocket: { open(socket) { milkySocket = socket; }, message() {} },
  });
  try {
    await copyHost(root);
    disableMemberPrewarm(root);
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${gateway.port}`, `access_token: ${token}`,
    ].join("\n") + "\n");
    await writeFile(join(root, "plugins", "v3-group-notices.js"), `
      export const apps = Object.fromEntries([
        "notice.group.msg_emoji_like", "notice.group.card", "notice.group.group_name",
        "notice.group.essence", "notice.group.decrease",
      ].map((key, index) => ["listener" + index, class extends plugin {
        constructor() { super({ event: key }); }
        async accept(e) {
          const { group_id, user_id, operator_id, message_id, message_seq, likes, face_id, reaction_type,
            is_add, is_set, card_old, card_new, name_new, new_group_name, sender_id, member, notice_type, sub_type, action_sub_type } = e;
          await e.reply(JSON.stringify({ key, group_id, user_id, operator_id, message_id, message_seq,
            likes, face_id, reaction_type, is_add, is_set, card_old, card_new, name_new, new_group_name, sender_id, member,
            notice_type, sub_type, action_sub_type }));
          return "return";
        }
      }]));
    `);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
    const stderr = new Response(host.stderr).text();
    let oneBot: WebSocket | undefined;
    try {
      const endpoint = await hostReady(host.stdout);
      const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
      const socket = oneBot = new Socket(endpoint, { headers: {
        Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": String(oneBotId),
      } });
      let receipt = 100;
      socket.addEventListener("message", ({ data }) => {
        const { action, params, echo } = JSON.parse(data);
        if (echo) socket.send(JSON.stringify({ echo, status: "ok", retcode: 0, data: { message_id: ++receipt } }));
        if (action === "send_msg") replies.push({ group_id: params.group_id, payload: JSON.parse(params.message) });
      });
      await waitFor(() => socket.readyState === WebSocket.OPEN ? true : undefined, "OneBot WebSocket 未连接。");
      const milky = await waitFor(() => milkySocket, "Milky WebSocket 未连接。");
      const one = (notice_type: string, data: object, self_id = oneBotId) =>
        socket.send(JSON.stringify({ post_type: "notice", notice_type, self_id, group_id: groupId, time: stamp, ...data }));
      const mk = (event_type: string, data: object, self_id = milkyId) =>
        milky.send(JSON.stringify({ event_type, self_id, time: stamp, data: { group_id: groupId, ...data } }));
      let nextReply = 0;
      async function verify(payload: { key: string; [field: string]: unknown }) {
        const index = nextReply++;
        const [, notice_type, sub_type] = payload.key.split(".");
        expect(await waitFor(() => replies[index], "V3 群事件监听未收到。")).toEqual({
          group_id: groupId, payload: { ...payload, notice_type, sub_type },
        });
      }

      const likes = [{ emoji_id: "66", count: 2 }];
      one("group_msg_emoji_like", { user_id: userId, message_id: -12, likes }, oneBotId + 9);
      one("group_msg_emoji_like", { user_id: userId, message_id: -12, likes: [{ emoji_id: "66", count: "2" }] });
      one("group_msg_emoji_like", { user_id: userId, message_id: -12, likes, is_add: true, message_seq: 12 });
      await verify({ key: "notice.group.msg_emoji_like", group_id: groupId, user_id: userId,
        message_id: -12, likes, is_add: true, message_seq: 12 });
      one("group_msg_emoji_like", { user_id: 0, message_id: -12, likes, is_add: false, message_seq: "12" });
      await verify({ key: "notice.group.msg_emoji_like", group_id: groupId, user_id: 0,
        message_id: -12, likes, is_add: false, message_seq: "12" });
      one("group_card", { user_id: userId, card_old: "旧名片", card_new: "新名片" });
      await verify({ key: "notice.group.card", group_id: groupId, user_id: userId, card_old: "旧名片", card_new: "新名片" });
      one("notify", { sub_type: "group_name", operator_id: userId, name_new: "新群名" });
      await verify({ key: "notice.group.group_name", group_id: groupId, user_id: userId, operator_id: userId, name_new: "新群名" });
      one("notify", { sub_type: "group_name", user_id: userId, name_new: "NapCat 新群名" });
      await verify({ key: "notice.group.group_name", group_id: groupId, user_id: userId, name_new: "NapCat 新群名" });
      for (const sub_type of ["add", "delete"]) {
        const operator_id = sub_type === "add" ? 0 : userId;
        one("essence", { sub_type, operator_id, user_id: 702, sender_id: 702, message_id: -12 });
        await verify({ key: "notice.group.essence", action_sub_type: sub_type, group_id: groupId, user_id: 702, operator_id, sender_id: 702, message_id: -12 });
      }
      one("group_decrease", { sub_type: "leave", user_id: userId });
      await verify({ key: "notice.group.decrease", action_sub_type: "leave", group_id: groupId, user_id: userId, member: { card: "新名片" } });

      const group_id = String(groupId);
      const user_id = String(userId);
      const reaction = { user_id: userId, message_seq: 0, face_id: "66", is_add: false, reaction_type: "emoji" };
      mk("group_message_reaction", reaction, milkyId + 9);
      mk("group_message_reaction", { ...reaction, is_add: "false" });
      mk("group_message_reaction", reaction);
      await verify({ key: "notice.group.msg_emoji_like", group_id, user_id, message_id: "0", message_seq: 0,
        face_id: "66", is_add: false, reaction_type: "emoji", likes: [{ emoji_id: "66", count: 0 }] });
      mk("group_message_reaction", { ...reaction, message_seq: 14, is_add: true, reaction_type: "face" });
      await verify({ key: "notice.group.msg_emoji_like", group_id, user_id, message_id: "14", message_seq: 14,
        face_id: "66", is_add: true, reaction_type: "face", likes: [{ emoji_id: "66", count: 1 }] });
      mk("group_name_change", { operator_id: userId, new_group_name: "Milky 新群名" });
      await verify({ key: "notice.group.card", group_id, user_id, operator_id: userId, new_group_name: "Milky 新群名" });
      mk("group_essence_message_change", { message_seq: 15, is_set: true, operator_id: userId });
      await verify({ key: "notice.group.essence", action_sub_type: "add", group_id, operator_id: user_id, message_id: "15", message_seq: 15, is_set: true });
      mk("group_essence_message_change", { message_seq: 15, is_set: false });
      await verify({ key: "notice.group.essence", action_sub_type: "delete", group_id, message_id: "15", message_seq: 15, is_set: false });
      expect(replies).toHaveLength(13);
    } finally {
      oneBot?.close();
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGTERM");
      await host.exited;
    }
    expect(await stderr).not.toContain("处理事件失败");
  } finally {
    gateway.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
