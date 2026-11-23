import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelRuntimeSettings } from "../lib/panel-runtime-settings.ts";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const oneBotToken = "public-file-onebot-fixture";
const httpToken = "public-file-http-fixture";
const fixtureName = "fixture-private.txt";
const publicBase = "https://files.example.invalid/bots/lotus";
const external = "https://files.example.invalid/public?file=from-elsewhere";
const bytes = [0, 255, 128, 65];
const pngHeader = [137, 80, 78, 71, 13, 10, 26, 10];

interface Links {
  readonly binary: string;
  readonly buffer: string;
  readonly blob: string;
  readonly base64: string;
  readonly limited: string;
  readonly external: string;
  readonly local: string | null;
}

async function readOutput(stream: ReadableStream<Uint8Array>, pattern: RegExp): Promise<RegExpExecArray> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) throw new Error("没有收到预期的文件链接输出。");
      output += decoder.decode(part.value, { stream: true });
      const match = pattern.exec(output);
      if (match) return match;
    }
  } finally {
    reader.releaseLock();
  }
}

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function getLinks(origin: URL, command: "#文件链接"): Promise<Links>;
function getLinks(origin: URL, command: "#文件到期"): Promise<{ expiring: string }>;
function getLinks(origin: URL, command: "#启动文件"): Promise<{ startup: string }>;
async function getLinks(origin: URL, command: "#文件链接" | "#文件到期" | "#启动文件"): Promise<Links | { expiring: string } | { startup: string }> {
  const endpoint = new URL("/OneBotv11", origin);
  endpoint.protocol = "ws:";
  const BunWebSocket = WebSocket as unknown as new (url: URL, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new BunWebSocket(endpoint, {
    headers: {
      Authorization: `Bearer ${oneBotToken}`, "X-Client-Role": "Universal", "X-Self-ID": "99",
    },
  });
  try {
    const reply = await deadline(new Promise<{ action: string; params: { message: string } }>((resolve, reject) => {
      socket.addEventListener("message", ({ data }) => resolve(JSON.parse(data)), { once: true });
      socket.addEventListener("error", () => reject(new Error("文件链接测试 OneBot 未连接。")), { once: true });
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        post_type: "message", message_type: "private", sub_type: "friend", self_id: 99, user_id: 42, message: command,
      })), { once: true });
    }), `未收到 ${command} 的 OneBot 回复。`);
    expect(reply).toMatchObject({ action: "send_msg", params: { message_type: "private", user_id: 42 } });
    return JSON.parse(reply.params.message);
  } finally {
    socket.close();
  }
}

async function withHost(
  config: { base?: string; defaultHits?: number; panelFileSharing?: { minutes: number; times: number | null } },
  run: (origin: URL, terminalFile: () => Promise<URL>) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-public-file-"));
  try {
    await copyHost(root);
    await mkdir(join(root, "config"), { recursive: true });
    const botConfig = ["online_msg_exp: 0"];
    if (config.defaultHits !== undefined) botConfig.push(`file_to_url_times: ${config.defaultHits}`);
    await writeFile(join(root, "config/bot.yaml"), botConfig.join("\n") + "\n");
    if (config.panelFileSharing) {
      const handler = panelRuntimeSettings(pathToFileURL(root + "/"));
      const endpoint = "http://localhost/panel/api/settings/native/runtime";
      const { values: previous } = await (await handler(new Request(endpoint), () => true)).json();
      const response = await handler(new Request(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ previous, values: { ...previous,
          file_to_url_time: config.panelFileSharing.minutes, file_to_url_times: config.panelFileSharing.times } }),
      }), () => true);
      expect(response.status).toBe(200);
    }
    if (config.base) await writeFile(join(root, "config/server.yaml"), `url: ${JSON.stringify(config.base)}\n`);
    disableMemberPrewarm(root);
    await writeFile(join(root, "plugins", fixtureName), "本机文件内容");
    await writeFile(join(root, "plugins", "public-file-fixture.js"), `
      const bytes = ${JSON.stringify(bytes)};
      export default class extends plugin {
        constructor() {
          super({ event: "message.private", rule: [
            { reg: "^#文件链接$", fnc: "links" },
            { reg: "^#文件到期$", fnc: "expiring" },
          ] });
        }
        async links(e) {
          let local;
          try {
            local = await Bot.fileToUrl(import.meta.dir + "/${fixtureName}");
          } catch {}
          return e.reply(JSON.stringify({
            binary: await Bot.fileToUrl(new Uint8Array(bytes), { name: "${fixtureName}" }),
            buffer: await Bot.fileToUrl(Buffer.from(bytes)),
            blob: await Bot.fileToUrl(new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" })),
            base64: await Bot.fileToUrl("base64://AP+AQQ=="),
            limited: await Bot.fileToUrl(new Uint8Array(bytes), { times: 1 }),
            external: await Bot.fileToUrl(${JSON.stringify(external)}),
            local: local || null,
          }));
        }
        async expiring(e) {
          return e.reply(JSON.stringify({ expiring: await Bot.fileToUrl(new Uint8Array(bytes), { time: 700 }) }));
        }
      }
    `);
    await writeFile(join(root, "plugins", "terminal-file-fixture.js"), `
      export default class extends plugin {
        constructor() { super({ event: "message.terminal", rule: [{ reg: "^#终端文件$", fnc: "show" }] }); }
        show(e) { return e.reply(["终端附件", segment.image(new Uint8Array(${JSON.stringify(pngHeader)}))]); }
      }
    `);
    if (config.base) {
      const fixture = join(root, "plugins", "startup-file-fixture");
      await mkdir(fixture);
      await writeFile(join(fixture, "package.json"), JSON.stringify({
        name: "startup-file-fixture", lotusYunzai: { entry: "./index.js" },
      }));
      await writeFile(join(fixture, "index.js"), `
        export async function createModule({ fileToUrl }) {
          const startup = await fileToUrl(new Uint8Array(${JSON.stringify(bytes)}), { time: null, times: 1 });
          return { commands: { "#启动文件": () => JSON.stringify({ startup }) } };
        }
      `);
    }
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: {
        PATH: process.env.PATH, LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0",
        LOTUS_HTTP_TOKEN: httpToken, LOTUS_ONEBOT_TOKEN: oneBotToken,
      },
    });
    const stderr = new Response(host.stderr).text();
    const timeout = setTimeout(() => host.kill("SIGKILL"), 8_000);
    try {
      const listen = readOutput(host.stdout, /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u);
      const origin = new URL((await deadline(listen, "文件链接测试宿主启动超时。"))[1]!);
      await run(origin, async () => {
        const reply = readOutput(host.stdout, /终端附件\n图片 (http:\/\/127\.0\.0\.1:\d+\/File\/[a-f0-9-]+)\n/u);
        host.stdin.write("#终端文件\n");
        host.stdin.flush();
        return new URL((await deadline(reply, "没有收到终端附件的临时链接。"))[1]!);
      });
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await host.exited;
      host.stdin.end();
      clearTimeout(timeout);
    }
    expect(await stderr).not.toContain("处理 OneBot 事件失败");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function request(url: URL | string, options?: RequestInit): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(2_000), ...options });
}

async function expectBytes(url: URL | string) {
  const response = await request(url);
  expect(response.status).toBe(200);
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(bytes);
}

test("TRSS 按实际监听端口发布 V3 文件，同端口保留 OneBot 与状态鉴权", async () => {
  await withHost({ defaultHits: 2 }, async (origin, terminalFile) => {
    const links = await getLinks(origin, "#文件链接");
    expect(links.external).toBe(external);
    expect(links.local).toBeNull();
    for (const link of [links.binary, links.buffer, links.blob, links.base64, links.limited]) {
      const url = new URL(link);
      expect(url.origin).toBe(origin.origin);
      expect(url.pathname).toMatch(/^\/File\/[^/]+$/u);
      expect(url.pathname).not.toContain(fixtureName);
    }
    expect((await request(new URL(`/File/${fixtureName}`, origin))).status).toBe(404);

    const head = await request(links.binary, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    await expectBytes(links.binary);
    await expectBytes(links.binary);
    expect((await request(links.binary)).status).toBe(404);
    for (const link of [links.buffer, links.blob, links.base64, links.limited]) await expectBytes(link);
    expect((await request(links.limited)).status).toBe(404);

    const { expiring } = await getLinks(origin, "#文件到期");
    await expectBytes(expiring);
    await Bun.sleep(850);
    expect((await request(expiring)).status).toBe(404);

    const status = new URL("/status", origin);
    expect((await request(status)).status).toBe(401);
    expect((await request(status, { headers: { Authorization: `Bearer ${oneBotToken}` } })).status).toBe(401);
    const authenticated = await request(status, { headers: { Authorization: `Bearer ${httpToken}` } });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toMatchObject({ status: "ok", name: "Lotus-Yunzai" });

    const terminalLink = await terminalFile();
    expect(terminalLink.origin).toBe(origin.origin);
    const terminalArtifact = await request(terminalLink);
    expect(terminalArtifact.status).toBe(200);
    expect(terminalArtifact.headers.get("Content-Type")).toBe("image/png");
    expect([...new Uint8Array(await terminalArtifact.arrayBuffer())]).toEqual(pngHeader);
  });
}, 12_000);

test("TRSS 发布链接使用 server.url 的反代前缀及面板保存的失效时间和不限次数", async () => {
  await withHost({ base: publicBase + "/", defaultHits: 1, panelFileSharing: { minutes: 0.02, times: null } }, async (origin) => {
    const { binary } = await getLinks(origin, "#文件链接");
    const { startup } = await getLinks(origin, "#启动文件");
    expect(startup).toStartWith(publicBase + "/File/");
    expect(binary).toStartWith(publicBase + "/File/");
    const local = new URL(binary.slice(publicBase.length), origin);
    expect(local.pathname).toMatch(/^\/File\/[^/]+$/u);
    for (let attempt = 0; attempt < 3; attempt++) await expectBytes(local);
    await Bun.sleep(1_350);
    expect((await request(local)).status).toBe(404);
    const startupLocal = new URL(startup.slice(publicBase.length), origin);
    await expectBytes(startupLocal);
    expect((await request(startupLocal)).status).toBe(404);
  });
}, 10_000);
