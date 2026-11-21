import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const token = "isolated-image-ocr";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
const alternatePng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAG7buVgAAAABJRU5ErkJggg==";
const image = (key: string) => ({ type: "image", data: { url: "https://gchat.qpic.cn/download?" + key } });
const text = (text: string) => ({ type: "text", data: { text } });
const quote = (id: number) => ({ type: "reply", data: { id } });
type Frame = { action: string; params: Record<string, any>; echo?: string };
const content = (frame: Frame) => JSON.stringify(frame.params.message);
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error(what);
}

test("旧 OCR 用同会话原图和真实引用，继承群禁用，Milky 无能力时不读取图片", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-ocr-host-"));
  const milkyFrames: Frame[] = [];
  const milky = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const action = new URL(request.url).pathname.split("/").at(-1)!;
    const params = await request.json() as Frame["params"];
    milkyFrames.push({ action, params });
    const data = action === "get_login_info" ? { uin: 100 } : { message_seq: 2 };
    return Response.json({ status: "ok", retcode: 0, data });
  }});
  const sockets: WebSocket[] = [];
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    await copyHost(root);
    await cp(new URL("../plugins/group", import.meta.url), join(root, "plugins/group"), {
      recursive: true, filter: path => !path.endsWith("/.git") && !path.endsWith("/node_modules"),
    });
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config/group.yaml"),
      "default: {groupCD: 0, singleCD: 0}\n78: {disable: [椰奶助手-其他]}\n");
    await writeFile(join(root, "config/milky.yaml"),
      `enable: true\nhost: 127.0.0.1\nport: ${milky.port}\nconnection: webhook\naccess_token: ${token}\n`);
    await writeFile(join(root, "preload.ts"), `
      const actual = globalThis.fetch;
      globalThis.fetch = (input, options) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname === "127.0.0.1") return actual(input, options);
        if (url.origin !== "https://gchat.qpic.cn" || url.pathname !== "/download" || options?.redirect !== "error" ||
            options?.credentials !== "omit" || new Headers(options?.headers).has("Cookie")) throw Error("fixture network guard");
        const source = url.search === "?quote" ? ${JSON.stringify(alternatePng)} : ${JSON.stringify(png)};
        return Promise.resolve(new Response(Buffer.from(source, "base64"), { headers: {"Content-Type":"image/png"} }));
      };
    `);
    disableMemberPrewarm(root);
    host = Bun.spawn([process.execPath, "--no-env-file", "--preload", "./preload.ts", "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
    let startup = "";
    const decoder = new TextDecoder();
    void host.stdout.pipeTo(new WritableStream({ write(chunk) { startup += decoder.decode(chunk, { stream: true }); } }));
    const ws = await waitFor(() => /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(startup)?.[0], "OneBot OCR host");
    const http = await waitFor(() => /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(startup)?.[1], "HTTP OCR host");
    const headers = { Authorization: "Bearer " + token };
    const WebSocketWithHeaders = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    let nativeOcrAvailable = true;
    const makeClient = async (identity: number, napcat: boolean) => {
      const socket = new WebSocketWithHeaders(ws, { headers: { ...headers, "X-Client-Role": "Universal", "X-Self-ID": String(identity) } });
      sockets.push(socket);
      const frames: Frame[] = [];
      socket.onmessage = ({ data }) => {
        const frame: Frame = JSON.parse(String(data));
        frames.push(frame);
        const { action, params, echo } = frame;
        if (!echo || socket.readyState !== WebSocket.OPEN) return;
        if (action === "ocr_image" && !nativeOcrAvailable) {
          socket.send(JSON.stringify({ echo, status: "failed", retcode: 1200, message: "OCR unavailable" }));
          return;
        }
        const result = action === "get_login_info" ? { user_id: identity } :
          action === "get_version_info" ? { app_name: napcat ? "NapCat.Onebot" : "unknown" } :
          action === "get_msg" ? { message_id: params.message_id, self_id: identity, message_type: "group",
            sender: { user_id: 52 }, group_id: params.message_id === 401 ? 77 : 91, message: [image("quote")] } :
          action === "ocr_image" ? { texts: [{ text: "第一行" }, { text: "[CQ:at,qq=all]" }] } :
          action === "get_group_list" || action === "get_friend_list" ? [] : { message_id: 122 };
        socket.send(JSON.stringify({ echo, status: "ok", retcode: 0, data: result }));
      };
      await waitFor(() => socket.readyState === WebSocket.OPEN || undefined, "OCR connection");
      let sequence = 100;
      return { frames, socket, async send(parts: object[], expected?: RegExp, group?: number, user = 51) {
        const before = frames.length;
        socket.send(JSON.stringify({ post_type: "message", self_id: identity, user_id: user,
          message_type: group ? "group" : "private", sub_type: group ? "normal" : "friend", group_id: group,
          message_id: ++sequence, sender: { user_id: user }, message: parts }));
        if (expected) return await waitFor(() => frames.slice(before).find(frame => frame.action === "send_msg" &&
          expected.test(content(frame))), "OCR reply " + expected.source);
        await Bun.sleep(100);
      }};
    };
    const client = await makeClient(99, true);
    const calls = () => client.frames.filter(frame => frame.action === "ocr_image");
    const reply = await client.send([text("#ocr"),image("current")], /第一行/u);
    expect(reply?.params.message).toEqual([
      expect.objectContaining({ type: "reply" }),
      { type: "text", data: { text: "第一行\n[CQ:at,qq=all]" } },
    ]);
    expect(calls().map(frame => frame.params.image)).toEqual(["base64://" + png]);

    await client.send([quote(401),text("#提取文字"),image("current")], /第一行/u, 77);
    expect(client.frames.find(frame => frame.action === "get_msg")?.params).toEqual({ message_id: 401 });
    expect(calls().at(-1)?.params.image).toBe("base64://" + alternatePng);

    await client.send([quote(402),text("#取文字")], /请发送图片或取消/u, 77);
    await client.send([image("other-group")], undefined, 79);
    await client.send([image("other-actor")], undefined, 77, 52);
    expect(calls()).toHaveLength(2);
    await client.send([text("取消")], /已取消图片文字识别/u, 77);
    await client.send([image("after-cancel")], undefined, 77);
    expect(calls()).toHaveLength(2);

    await Bun.sleep(1_020);
    await client.send([text("#取文字")], /请发送图片或取消/u, 77);
    await client.send([image("continuation")], /第一行/u, 77);
    expect(calls()).toHaveLength(3);

    await client.send([text("#ocr"),image("blocked")], undefined, 78);
    await client.send([text("#ocr"), { type: "image", data: { file: "/private/image.png" } }], /无法读取这张图片/u);
    expect(calls()).toHaveLength(3);
    nativeOcrAvailable = false;
    await client.send([text("#提取文字"),image("native-unsupported")], /图片文字识别失败/u);
    expect(calls()).toHaveLength(4);
    const other = await makeClient(101, false);
    await other.send([text("#ocr"),image("another-gateway")], /当前协议端暂不支持/u);
    expect(other.frames.some(frame => frame.action === "ocr_image")).toBe(false);

    const webhook = (event_type: string, data: object) => fetch(http + "/milky", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ self_id: 100, time: 1_700_000_000, event_type, data }),
    });
    await waitFor(async () => (await webhook("fixture", {})).status === 200 || undefined, "Milky OCR session");
    const milkyResponse = await webhook("message_receive", { time: 1_700_000_000, sender_id: 51, peer_id: 51,
      message_seq: 12, message_scene: "friend", segments: [text("#提取文字"),
        { type: "image", data: { uri: "https://gchat.qpic.cn/download?unsupported" } }],
    });
    expect(milkyResponse.status).toBe(200);
    await waitFor(() => milkyFrames.find(frame => frame.action === "send_private_message" &&
      /当前协议端暂不支持/u.test(content(frame))), "Milky OCR unsupported reply");
    expect(milkyFrames.some(frame => frame.action === "ocr_image" || frame.action === "get_message")).toBe(false);
  } finally {
    for (const socket of sockets) socket.close();
    host?.kill("SIGKILL");
    await host?.exited;
    milky.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
