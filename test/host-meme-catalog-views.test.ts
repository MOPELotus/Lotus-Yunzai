import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeCatalogTable } from "../plugins/meme/catalog-file.ts";
import { isExcludedMemeTemplate } from "../plugins/meme/template-policy.ts";
import { builtinMemeTemplates } from "../plugins/meme/templates/index.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const proof = Bun.env.LOTUS_MEME_CATALOG_GPU_PROOF;
const skiaEntry = join(import.meta.dir, "../packages/skia/node_modules/skia-canvas/lib/index.js");
const description = "可选参数：[circle: 是否将图片变为圆形]\n参数命令：[大圆]\n预览图片：";
const offline = `
Bun.env.LOTUS_SKIA_MODE = "gpu";
${proof ? `
import { Canvas } from ${JSON.stringify(skiaEntry)};
import { appendFileSync } from "node:fs";
Bun.env.VK_DRIVER_FILES = "/usr/share/vulkan/icd.d/nvidia_icd.json";
const write = Canvas.prototype.toBuffer;
Canvas.prototype.toBuffer = async function (...args) {
  const output = await write.call(this, ...args);
  if (this.engine.renderer !== "GPU" || this.engine.api !== "Vulkan" || !this.engine.device?.includes("RTX A4000")) throw Error("缺少物理显卡验证");
  appendFileSync(${JSON.stringify(join(proof, "engine.jsonl"))}, JSON.stringify(this.engine) + "\\n");
  return output;
};
` : ""}

const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "127.0.0.1") return nativeFetch(input, init);
  await Bun.write("blocked-meme-request", url.hostname);
  throw new Error("本机表情夹具禁止外网。");
}, nativeFetch);
`;

async function copyMeme(root: string) {
  const source = fileURLToPath(new URL("../plugins/meme/", import.meta.url));
  const destination = join(root, "plugins", "meme");
  await cp(source, destination, {
    recursive: true, filter: file => basename(file) !== ".git" && basename(file) !== "node_modules",
  });
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir");
  await linkHostPackages(root);
}

async function catalog(root: string, server: URL) {
  await copyMeme(root);
  const data = join(root, "data", "meme");
  const config = join(data, "config");
  await mkdir(config, { recursive: true });
  const available = builtinMemeTemplates.map(({ info }) => info)
    .filter(({ key, tags }) => !isExcludedMemeTemplate(key, tags)).map(({ key }) => key);
  const visible = new Set(["petpet", "turn", ...available.filter(key => key !== "petpet" && key !== "turn").slice(0, 11)]);
  await writeFile(join(config, "access.yaml"), Bun.YAML.stringify({
    blackListEnable: true, blackList: available.filter(key => !visible.has(key)),
  }));
  // An old server setting must not bring the remote source back.
  await writeFile(join(config, "server.yaml"), `url: ${server.href}\n`);
  const db = new Database(join(data, "data.db"));
  try {
    db.run(`CREATE TABLE preset (name TEXT PRIMARY KEY, key TEXT NOT NULL,
      arg_name TEXT NOT NULL, arg_value TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE stat (key TEXT PRIMARY KEY, "all" INTEGER NOT NULL);
      INSERT INTO stat VALUES ('petpet', 9), ('turn', 4);`);
    db.run("INSERT INTO preset VALUES (?, ?, ?, ?, ?, ?)", ['"大圆"', "petpet", "circle", "true", "fixture", "fixture"]);
  } finally { db.close(); }
}

function imageBytes(value: unknown) {
  const serialized = JSON.stringify(value);
  const encoded = /base64:\/\/([A-Za-z0-9+/]+={0,2})/u.exec(serialized)?.[1];
  if (!encoded) throw new Error("回复缺图片数据");
  return Uint8Array.fromBase64(encoded);
}

test("正常宿主通过 OneBot 和 Milky 返回目录、统计信息卡及同源详情原图", async () => {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    return new Response(null, { status: 503 });
  } });
  try {
    await withDualGatewayFixture("catalog-views-fixture", "disablePrivate: false\n", async ({ root, milky, onebot, sendOneBot, sendMilky }) => {
      sendOneBot("#表情列表");
      const oneList = await onebot.next("send_msg");
      expect(oneList.params).toMatchObject({ user_id: 42, message: [{ type: "image" }] });
      const rendered = imageBytes(oneList.params);
      if (proof) await Bun.write(join(proof, "catalog.png"), rendered);
      const metadata = await new Bun.Image(rendered).metadata();
      expect(metadata).toMatchObject({ width: 3600, format: "png" });

      await sendMilky("meme列表");
      const otherList = await milky.next("send_private_message");
      expect(otherList.params).toMatchObject({ user_id: 43, message: [{ type: "image" }] });
      expect(imageBytes(otherList.params)).toEqual(rendered);
      otherList.respond({ message_seq: 102 });

      sendOneBot("#表情统计");
      const oneUsage = await onebot.next("send_msg");
      expect(oneUsage.params).toMatchObject({ user_id: 42, message: [{ type: "image" }] });
      const usage = imageBytes(oneUsage.params);
      if (proof) await Bun.write(join(proof, "usage.png"), usage);
      expect(await new Bun.Image(usage).metadata()).toMatchObject({ width: 4608, format: "png" });

      await sendMilky("meme统计");
      const otherUsage = await milky.next("send_private_message");
      expect(otherUsage.params).toMatchObject({ user_id: 43, message: [{ type: "image" }] });
      expect(imageBytes(otherUsage.params)).toEqual(usage);
      otherUsage.respond({ message_seq: 105 });

      sendOneBot("#表情列表 2");
      expect((await onebot.next("send_msg")).params).toMatchObject({ user_id: 42, message: expect.stringContaining("表情列表 2/2") });

      sendOneBot("#表情详情 摸", { message_id: 901 });
      const oneDetail = await onebot.next("send_msg");
      expect(oneDetail.params).toMatchObject({ user_id: 42, message: [
        { type: "reply", data: { id: "901" } }, { type: "text", data: { text: expect.stringContaining(description) } }, { type: "image" },
      ] });
      const preview = Buffer.from(imageBytes(oneDetail.params));
      expect(preview.subarray(0, 6).toString("ascii")).toBe("GIF89a");
      expect([preview.readUInt16LE(6), preview.readUInt16LE(8)]).toEqual([112, 112]);

      await sendMilky("表情详情摸", { message_seq: 902 });
      const otherDetail = await milky.next("send_private_message");
      expect(otherDetail.params).toMatchObject({ user_id: 43, message: [
        { type: "reply", data: { message_seq: 902 } }, { type: "text", data: { text: expect.stringContaining(description) } }, { type: "image" },
      ] });
      expect(imageBytes(otherDetail.params)).toEqual(new Uint8Array(preview));
      otherDetail.respond({ message_seq: 104 });

      expect(requests).toEqual([]);
      expect(await Bun.file(join(root, "blocked-meme-request")).exists()).toBe(false);
      expect(await Bun.file(join(root, "data", "meme", "backend", "resources", "resources.json")).exists()).toBe(false);
    }, 10_000, offline, root => catalog(root, new URL("/source/", server.url)));
  } finally { server.stop(true); }
}, 20_000);

test("本机表情目录在宿主启动后通过两种协议生成预览", async () => {
  const requests: string[] = [];
  const remote = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(request.url);
    return new Response(null, { status: 503 });
  } });
  try {
    await withDualGatewayFixture("native-meme-views-fixture", "disablePrivate: false\n", async ({ milky, onebot, sendOneBot, sendMilky, root }) => {
      const database = join(root, "data", "meme", "data.db");
      const deadline = performance.now() + 4_000;
      let ready = false;
      while (!ready && performance.now() < deadline) {
        if (await Bun.file(database).exists()) {
          const db = new Database(database, { readonly: true });
          try {
            const initialized = db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(nativeCatalogTable);
            ready = !!initialized && db.query(`SELECT 1 FROM ${nativeCatalogTable} WHERE key = 'turn'`).get() !== null;
          } finally { db.close(); }
        }
        if (!ready) await Bun.sleep(40);
      }
      expect(ready).toBe(true);

      sendOneBot("#表情详情 转");
      const first = await onebot.next("send_msg");
      expect(first.params).toMatchObject({ user_id: 42 });
      const gif = Buffer.from(imageBytes(first.params));
      expect(gif.subarray(0, 6).toString("ascii")).toBe("GIF89a");
      expect([gif.readUInt16LE(6), gif.readUInt16LE(8)]).toEqual([250, 250]);

      await sendMilky("表情详情转");
      const second = await milky.next("send_private_message");
      expect(second.params).toMatchObject({ user_id: 43 });
      expect(Buffer.from(imageBytes(second.params)).subarray(0, 6).toString("ascii")).toBe("GIF89a");
      second.respond({ message_seq: 108 });
      expect(requests).toEqual([]);
      expect(await Bun.file(join(root, "blocked-meme-request")).exists()).toBe(false);
    }, 10_000, offline, async root => {
      await copyMeme(root);
      const config = join(root, "data", "meme", "config");
      await mkdir(config, { recursive: true });
      await writeFile(join(config, "server.yaml"), `backend: managed\nurl: ${remote.url.href}\n`);
    });
  } finally { remote.stop(true); }
}, 20_000);
