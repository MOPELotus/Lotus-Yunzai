import { expect, test } from "bun:test";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../scripts/web-mount-node.mjs", import.meta.url));
const binary = Bun.which("node");
const supported = process.platform !== "win32" && binary !== null && Bun.spawnSync({
  cmd: [binary, "--input-type=module", "-e", 'import * as m from "node:module"; import "node:sqlite"; process.exit(typeof m.registerHooks === "function" ? 0 : 1);'],
  stdout: "ignore", stderr: "ignore",
}).exitCode === 0;

async function fixture(body: (plugin: string, root: string, socket: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "wm-node-"));
  const plugin = join(root, "plugin");
  const privateDir = join(root, "private");
  try {
    await mkdir(join(plugin, "guoba"), { recursive: true });
    await mkdir(join(plugin, "lib"));
    await mkdir(privateDir, { mode: 0o700 });
    await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "web-mount", version: "1.5.18", type: "module" }));
    await writeFile(join(plugin, "lib", "status.js"), `
      export const state = { timer: setInterval(() => {}, 30000) };
      export let port = 1000;
      export const setPort = next => { port = next; };
    `);
    await writeFile(join(plugin, "index.js"), `
      import Plugin from "../../lib/plugins/plugin.js";
      export default class extends Plugin {
        init() {
          Bot.express.use((req, res, next) => {
            if (req.url.startsWith('/__web-mount__')) return res.end('private!');
            if (req.url !== '/echo?mode=business') return next();
            req.pipe(res);
          });
          const [fallback] = Bot.server.listeners('upgrade');
          Bot.server.removeAllListeners('upgrade');
          Bot.server.on('upgrade', (req, socket, head) => {
            if (req.url === '/socket') socket.end('HTTP/1.1 418 I am a teapot\\r\\nConnection: close\\r\\n\\r\\n');
            else fallback(req, socket, head);
          });
          return true;
        }
      }
    `);
    await writeFile(join(plugin, "guoba", "index.js"), `
      import fs from "node:fs";
      import { port, setPort } from "../lib/status.js";
      export function init(ctx) {
        ctx.registerPage({id:"web-mount"});
        ctx.registerApi('get','/data', (_req,res) => res.json({ok:true, result:port}));
        ctx.registerApi('get','/config', (_req,res) => res.json({ok:true, result:{port}}));
        ctx.registerApi('post','/config', ({body},res) => {
          if (!Number.isInteger(body.port)) return res.status(422).json({ok:false});
          fs.writeFileSync(new URL('../saved.json',import.meta.url), JSON.stringify(body));
          setPort(body.port);
          res.json({ok:true});
        });
        ctx.registerApi('post','/reload', (_req,res) => { throw Error('private-fixture-detail'); });
        ctx.registerApi('post','/reset', (_req,res) => res.json({ok:true}));
      }
    `);
    await body(plugin, root, join(privateDir, "api.sock"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function start(root: string, plugin: string, socket: string, port = "0") {
  return Bun.spawn([binary!, entry, plugin, socket, port], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}

async function readPort(stdout: ReadableStream<Uint8Array>) {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  try {
    let contents = "";
    while (!contents.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Node 端口挂载服务未报告就绪。");
      contents += decoder.decode(chunk.value, { stream: true });
    }
    const ready = JSON.parse(contents.split("\n", 1)[0]!) as { port?: unknown };
    if (typeof ready.port !== "number" || ready.port <= 0) throw new Error("业务监听端口无效。");
    return ready.port;
  } finally {
    reader.releaseLock();
  }
}

test.skipIf(!supported)("原插件基类替换、Unix RPC、业务监听与关机隔离", () => fixture(async (plugin, root, socket) => {
  const child = start(root, plugin, socket);
  const errors = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill("SIGKILL"), 6_000);
  try {
    const port = await readPort(child.stdout);
    expect((await lstat(socket)).isSocket()).toBe(true);
    expect((await lstat(socket)).mode & 0o777).toBe(0o600);
    expect((await lstat(socket)).uid).toBe(process.getuid!());
    const business = (path: string, options?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, options);
    const rpc = (path: string, options?: RequestInit) =>
      fetch(`http://localhost${path}`, { ...options, unix: socket, signal: AbortSignal.timeout(2_000) });
    for (const path of ["/__web-mount__", "/__web-mount__/", "/__web-mount__/config", "/__web-mount__?format=json"]) {
      expect((await business(path)).status).toBe(404);
    }
    const rawStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = get({ host: "127.0.0.1", port, path: "/__web-mount__/../business?raw=1" }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      request.once("error", reject);
    });
    expect(rawStatus).toBe(404);
    const upgradeStatus = async (path: string) => (await business(path, {
      headers: { Connection: "Upgrade", Upgrade: "websocket" },
      signal: AbortSignal.timeout(2_000),
    })).status;
    expect(await upgradeStatus("/socket")).toBe(418);
    expect(await upgradeStatus("/missing-socket")).toBe(404);
    expect((await business("/data")).status).toBe(404);
    const bytes = Uint8Array.of(0, 44, 128, 255);
    const response = await business("/echo?mode=business", { method: "POST", body: bytes });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect((await rpc("/echo?mode=business")).status).toBe(404);
    expect((await rpc("/config?anything=1")).status).toBe(404);
    expect(await (await rpc("/config")).json()).toEqual({ ok: true, result: { port: 1000 } });
    expect((await rpc("/config", { method: "POST", body: "{no", headers: { "Content-Type": "application/json" } })).status).toBe(400);
    expect((await rpc("/config", { method: "POST", body: "{}" })).status).toBe(415);
    expect((await rpc("/config", { method: "POST", body: " ".repeat(65_537), headers: { "Content-Type": "application/json" } })).status).toBe(413);
    expect((await rpc("/config", { method: "POST", body: JSON.stringify({ port: 2000 }), headers: { "Content-Type": "application/json" } })).status).toBe(200);
    expect(await (await rpc("/data")).json()).toEqual({ ok: true, result: 2000 });
    expect(JSON.parse(await readFile(join(plugin, "saved.json"), "utf8"))).toEqual({ port: 2000 });
    expect(await (await rpc("/reload", { method: "POST" })).json()).toEqual({ ok: false });
    expect(await (await rpc("/reset", { method: "POST" })).json()).toEqual({ ok: true });

    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(await errors).toBe("");
    await expect(lstat(socket)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}), 8_000);

test.skipIf(!supported)("拒绝可共享或链接的 socket 父目录以及已存在的文件", () => fixture(async (plugin, root, socket) => {
  const linked = join(root, "linked");
  await symlink(join(root, "private"), linked);
  const run = async (path: string) => {
    const child = start(root, plugin, path);
    const errors = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    return errors;
  };

  expect(await run(join(linked, "api.sock"))).toContain("0700 实体目录");
  await chmod(join(root, "private"), 0o755);
  expect(await run(socket)).toContain("0700 实体目录");
  await chmod(join(root, "private"), 0o700);
  await writeFile(socket, "existing");
  expect(await run(socket)).toContain("路径已存在");
  expect(await readFile(socket, "utf8")).toBe("existing");
}));

test.skipIf(!supported)("业务端口绑定失败会撤销已创建的 RPC socket", () => fixture(async (plugin, root, socket) => {
  const busy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const child = start(root, plugin, socket, String(busy.port));
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain(`业务端口 ${busy.port} 已被占用`);
    await expect(lstat(socket)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    clearTimeout(timer);
    await busy.stop(true);
  }
}));

test.skipIf(!supported)("同名启动互斥，SIGKILL 后重新使用原 RPC 路径", () => fixture(async (plugin, root, socket) => {
  const children: ReturnType<typeof start>[] = [];
  const launch = () => {
    const child = start(root, plugin, socket);
    children.push(child);
    return child;
  };
  const owner = launch();
  const timeout = setTimeout(() => children.forEach(child => child.kill("SIGKILL")), 5_000);
  try {
    await readPort(owner.stdout);
    const lock = await lstat(`${socket}.lock.sqlite3`);
    expect(lock.mode & 0o777).toBe(0o600);

    const contender = launch();
    expect(await contender.exited).toBe(1);
    expect(await new Response(contender.stderr).text()).toContain("另一个端口挂载进程使用");
    const rpc = () => fetch("http://localhost/data", { unix: socket, signal: AbortSignal.timeout(2_000) });
    expect(await (await rpc()).json()).toEqual({ ok: true, result: 1000 });
    const original = await lstat(socket);

    owner.kill("SIGKILL");
    await owner.exited;
    expect(owner.signalCode).toBe("SIGKILL");
    expect((await lstat(socket)).ino).toBe(original.ino);

    const recovered = launch();
    await readPort(recovered.stdout);
    expect((await lstat(socket)).mode & 0o777).toBe(0o600);
    expect(await (await rpc()).json()).toEqual({ ok: true, result: 1000 });
    recovered.kill("SIGTERM");
    expect(await recovered.exited).toBe(0);
    await expect(lstat(socket)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(`${socket}.lock.sqlite3`)).ino).toBe(lock.ino);
  } finally {
    clearTimeout(timeout);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }
}), 8_000);

test.skipIf(!supported)("保留其他服务仍在监听的同名 Unix socket", () => fixture(async (plugin, root, socket) => {
  const active = Bun.serve({ unix: socket, fetch: () => new Response("external") });
  await chmod(socket, 0o600);
  const original = await lstat(socket);
  const child = start(root, plugin, socket);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("已被占用或无法确认");
    expect((await lstat(socket)).ino).toBe(original.ino);
    const response = await fetch("http://localhost/data", { unix: socket, signal: AbortSignal.timeout(2_000) });
    expect(await response.text()).toBe("external");
  } finally {
    clearTimeout(timeout);
    await active.stop(true);
  }
}));

test.skipIf(!supported)("停止端口挂载时关闭未收到 101 的上游握手", () => fixture(async (plugin, root, socket) => {
  const pending = Promise.withResolvers<string>();
  const closed = Promise.withResolvers<void>();
  let headers = "";
  const backend = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
    data(_socket, data) {
      headers += Buffer.from(data).toString("utf8");
      if (headers.includes("\r\n\r\n")) pending.resolve(headers);
    },
    close() { closed.resolve(); },
  } });
  try {
    await writeFile(join(plugin, "index.js"), `
      import Plugin from "../../lib/plugins/plugin.js";
      import http from "node:http";
      export default class extends Plugin {
        init() {
          Bot.express.use((_req, _res, next) => next());
          const [fallback] = Bot.server.listeners('upgrade');
          Bot.server.removeAllListeners('upgrade');
          Bot.server.on('upgrade', (req, socket, head) => {
            if (req.url !== '/pending') return fallback(req, socket, head);
            const upstream = http.request({ host: '127.0.0.1', port: ${backend.port}, path: req.url, headers: req.headers });
            upstream.on('error', () => socket.destroy());
            upstream.end();
          });
          return true;
        }
      }
    `);
    const child = start(root, plugin, socket);
    const killAtDeadline = setTimeout(() => child.kill("SIGKILL"), 4_000);
    const signal = AbortSignal.timeout(3_000);
    try {
      const port = await readPort(child.stdout);
      const client = createConnection({ host: "127.0.0.1", port });
      const disconnected = once(client, "close", { signal });
      try {
        await once(client, "connect", { signal });
        client.write("GET /pending HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
        const received = await Promise.race([pending.promise, child.exited.then(() => "")]);
        expect(received).toMatch(/^GET \/pending HTTP\/1\.1\r\n[\s\S]*\r\nupgrade: websocket\r\n/iu);
        child.kill("SIGTERM");
        await Bun.sleep(20);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        expect(await child.exited).toBe(0);
        await Promise.all([disconnected, closed.promise]);
        await expect(lstat(socket)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        client.destroy();
      }
    } finally {
      clearTimeout(killAtDeadline);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  } finally {
    backend.stop(true);
  }
}), 6_000);
