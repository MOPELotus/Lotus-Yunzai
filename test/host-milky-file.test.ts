import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const token = "milky-file-fixture";
const botId = 99;
const friendId = 42;
const groupId = 77;
const time = 1_700_000_000;
const fileHash = "0123456789abcdef0123456789abcdef01234567";
const privateUrl = "https://downloads.example.invalid/private?token=fixture";
const groupUrl = "https://downloads.example.invalid/group?token=fixture";
const blockedTip = "私聊当前只处理记录文件";

function deadline<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function mockGateway() {
  const calls: { action: string; body: unknown; receivedAt: number }[] = [];
  let ready = Promise.withResolvers<void>();
  let handled = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${token}`) {
        return new Response(null, { status: 401 });
      }
      const action = new URL(request.url).pathname.slice("/api/".length);
      calls.push({ action, body: await request.json(), receivedAt: performance.now() });
      ready.resolve();

      function success(data: object) {
        return Response.json({ status: "ok", retcode: 0, data });
      }
      switch (action) {
        case "get_login_info": return success({ uin: botId, nickname: "文件夹具" });
        case "get_private_file_download_url": return success({ download_url: privateUrl });
        case "get_group_file_download_url": return success({ download_url: groupUrl });
        case "send_private_message":
        case "send_group_message": return success({ message_seq: 100 + calls.length, time });
        default: return new Response(null, { status: 404 });
      }
    },
  });
  return {
    server,
    async next(action: string, body: unknown) {
      if (handled === calls.length) await deadline(ready.promise, `未收到 Milky ${action} 动作。`);
      const call = calls[handled++]!;
      if (handled === calls.length) ready = Promise.withResolvers<void>();
      expect({ action: call.action, body: call.body }).toEqual({ action, body });
      return call;
    },
    expectDrained() { expect(calls).toHaveLength(handled); },
  };
}

async function startup(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("Lotus-Yunzai 已启动")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Milky 文件测试宿主未启动。\n" + output);
      output += decoder.decode(chunk.value, { stream: true });
    }
    const origin = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1];
    if (!origin) throw new Error("Milky 文件测试宿主未输出 HTTP 监听地址。");
    return new URL("/milky", origin);
  } finally {
    reader.releaseLock();
  }
}

function webhook(endpoint: URL, eventType: string, data: object) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ self_id: botId, time, event_type: eventType, data }),
    signal: AbortSignal.timeout(2_000),
  });
}

async function waitForBind(endpoint: URL) {
  const stopAt = performance.now() + 2_000;
  for (;;) {
    const response = await webhook(endpoint, "fixture_unsupported", {});
    if (response.status !== 503 || performance.now() >= stopAt) {
      expect(response.status).toBe(200);
      return;
    }
    await Bun.sleep(25);
  }
}

function file(file_id: string, file_name: string, file_size: number, hash?: string) {
  return { type: "file", data: { file_id, file_name, file_size, ...(hash === undefined ? {} : { file_hash: hash }) } };
}

function text(text: string) {
  return { type: "text", data: { text } };
}

async function send(endpoint: URL, message_seq: number, segments: object[], sender_id = friendId, group?: number) {
  expect((await webhook(endpoint, "message_receive", {
    time, message_seq, sender_id, peer_id: group ?? sender_id,
    message_scene: group === undefined ? "friend" : "group", segments,
  })).status).toBe(200);
}

test("Milky 文件消息与上传通知走旧插件入口，保留原会话和私聊文件限制", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-file-"));
  const mock = mockGateway();
  try {
    await copyHost(root);
    await mkdir(join(root, "config", "config"), { recursive: true });
    await writeFile(join(root, "config", "config", "other.yaml"), `disablePrivate: true\ndisableMsg: ${blockedTip}\n`);
    await writeFile(join(root, "config", "config", "group.yaml"), "default:\n  groupCD: 0\n  singleCD: 0\n");
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${mock.server.port}`,
      "connection: webhook", `access_token: ${token}`,
    ].join("\n") + "\n");
    await writeFile(join(root, "plugins", "milky-file-fixture.js"), `
      export default class extends plugin {
        constructor() { super({ event: "message", rule: [{ fnc: "inspect" }] }); }
        async inspect(e) {
          if (!e.file) return false;
          const { type, file, name, size, getDownloadUrl } = e.file;
          const firstFile = e.file === e.message.find((part) => part.type === "file");
          const hashExposed = JSON.stringify(e.message).includes(${JSON.stringify(fileHash)}) ||
            JSON.stringify(e.file).includes(${JSON.stringify(fileHash)});
          const url = name.endsWith(".JSON") ? await getDownloadUrl?.() : undefined;
          return e.reply(JSON.stringify({
            type, file, name, size, firstFile, hashExposed, hasDownload: typeof getDownloadUrl === "function",
            url: url ?? null, messageId: e.message_id ?? null,
          }));
        }
      }
    `);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0" },
    });
    const stderr = new Response(host.stderr).text();
    try {
      const endpoint = await deadline(startup(host.stdout), "Milky 文件测试宿主启动超时。");
      await mock.next("get_login_info", {});
      await waitForBind(endpoint);
      async function metadata(
        source: ReturnType<typeof file>, hasDownload: boolean, url: string | null, messageId: number | null, group?: number,
      ) {
        const { file_id, file_name, file_size } = source.data;
        const message = [text(JSON.stringify({
          type: "file", file: file_id, name: file_name, size: file_size,
          firstFile: true, hashExposed: false, hasDownload, url, messageId,
        }))];
        if (group === undefined) await mock.next("send_private_message", { user_id: friendId, message });
        else await mock.next("send_group_message", { group_id: group, message });
      }
      async function upload(source: ReturnType<typeof file>, userId = friendId) {
        expect((await webhook(endpoint, "friend_file_upload", { ...source.data, user_id: userId, is_self: false })).status).toBe(200);
      }

      const json = file("private-json", "抽卡记录.JSON", 36, fileHash);
      await send(endpoint, 1, [json]);
      await mock.next("get_private_file_download_url", { user_id: friendId, file_id: json.data.file_id, file_hash: fileHash });
      await metadata(json, true, privateUrl, 1);

      await upload(json);
      const sheet = file("private-sheet", "表格.xlsx", 48, fileHash);
      await send(endpoint, 2, [sheet]);
      await metadata(sheet, true, null, 2);
      const notes = file("private-notes", "日志.txt", 0);
      await send(endpoint, 3, [notes]);
      await metadata(notes, false, null, 3);

      const executable = file("private-executable", "记录.json.exe", 90, fileHash);
      await send(endpoint, 4, [executable], 43);
      await mock.next("send_private_message", { user_id: 43, message: [text(blockedTip)] });
      await send(endpoint, 5, [json, executable], 44);
      await mock.next("send_private_message", { user_id: 44, message: [text(blockedTip)] });

      const groupFile = file("group-json", "群记录.JSON", 100, fileHash);
      await send(endpoint, 6, [groupFile], friendId, groupId);
      await mock.next("get_group_file_download_url", { group_id: groupId, file_id: groupFile.data.file_id });
      await metadata(groupFile, true, groupUrl, 6, groupId);
      const secondGroupFile = file("group-notes", "群日志.txt", 20);
      await send(endpoint, 7, [secondGroupFile], friendId, groupId);
      await metadata(secondGroupFile, true, null, 7, groupId);
      await send(endpoint, 7, [secondGroupFile], friendId, groupId);

      const preferredMessage = file("preferred-message", "聊天包优先.xlsx", 56, fileHash);
      await upload(preferredMessage);
      await send(endpoint, 8, [preferredMessage]);
      await metadata(preferredMessage, true, null, 8);

      const uploadOnly = file("upload-only", "只有通知.JSON", 72, fileHash);
      const notifiedAt = performance.now();
      await upload(uploadOnly);
      const fallbackLookup = await mock.next("get_private_file_download_url", {
        user_id: friendId, file_id: uploadOnly.data.file_id, file_hash: fileHash,
      });
      expect(fallbackLookup.receivedAt - notifiedAt).toBeGreaterThanOrEqual(950);
      await metadata(uploadOnly, true, privateUrl, null);
      await send(endpoint, 9, [uploadOnly]);
      await send(endpoint, 10, [text("文件补充说明"), uploadOnly]);
      await mock.next("get_private_file_download_url", {
        user_id: friendId, file_id: uploadOnly.data.file_id, file_hash: fileHash,
      });
      await metadata(uploadOnly, true, privateUrl, 10);

      await upload(executable, 45);
      await mock.next("send_private_message", { user_id: 45, message: [text(blockedTip)] });
      await Bun.sleep(80);
      mock.expectDrained();
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await host.exited;
    }
    expect(await stderr).not.toContain(fileHash);
  } finally {
    mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
