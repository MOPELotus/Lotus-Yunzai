import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const bytes = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const description = "标签：[旧标签]\n可选参数：[radius: 设置半径]\n参数命令：[大圆]\n预览图片：";

async function copyMeme(root: string) {
  const source = fileURLToPath(new URL("../plugins/meme/", import.meta.url));
  const destination = join(root, "plugins", "meme");
  await cp(source, destination, {
    recursive: true, filter: file => basename(file) !== ".git" && basename(file) !== "node_modules",
  });
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir");
}

async function catalog(root: string, server: URL) {
  await copyMeme(root);
  const data = join(root, "data", "meme");
  const config = join(data, "config");
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "other.yaml"), "autoUpdateRes: false\n");
  await writeFile(join(config, "server.yaml"), `url: ${server.href}\n`);
  const db = new Database(join(data, "data.db"));
  try {
    db.run(`CREATE TABLE meme (key TEXT PRIMARY KEY, keyWords TEXT, min_images INTEGER, max_images INTEGER,
      min_texts INTEGER, max_texts INTEGER, params TEXT, defText TEXT, tags TEXT);
      CREATE TABLE preset (name TEXT PRIMARY KEY, key TEXT);
      CREATE TABLE stat (key TEXT PRIMARY KEY, "all" INTEGER NOT NULL);
      INSERT INTO stat VALUES ('demo0', 9), ('demo1', 4);`);
    const insert = db.query("INSERT INTO meme VALUES (?, ?, 1, 2, 1, 1, ?, ?, ?)");
    for (let index = 0; index < 13; index++) {
      insert.run(`demo${index}`, JSON.stringify([`别名${index}`]), JSON.stringify({
        args_type: { args_model: { properties: { radius: { description: "设置半径" } } } },
      }), '["示例文本"]', '["旧标签"]');
    }
    db.run("INSERT INTO preset VALUES (?, ?)", ['"大圆"', "demo0"]);
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
    return path === "/source/memes/demo0/preview"
      ? new Response(Uint8Array.fromBase64(bytes), { headers: { "Content-Type": "image/png" } }) : new Response(null, { status: 404 });
  } });
  try {
    await withDualGatewayFixture("catalog-views-fixture", "disablePrivate: false\n", async ({ milky, onebot, sendOneBot, sendMilky }) => {
      sendOneBot("#表情列表");
      const oneList = await onebot.next("send_msg");
      expect(oneList.params).toMatchObject({ user_id: 42, message: [{ type: "image" }] });
      const rendered = imageBytes(oneList.params);
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
      expect(await new Bun.Image(usage).metadata()).toMatchObject({ width: 4608, format: "png" });

      await sendMilky("meme统计");
      const otherUsage = await milky.next("send_private_message");
      expect(otherUsage.params).toMatchObject({ user_id: 43, message: [{ type: "image" }] });
      expect(imageBytes(otherUsage.params)).toEqual(usage);
      otherUsage.respond({ message_seq: 105 });

      sendOneBot("#表情列表 2");
      expect((await onebot.next("send_msg")).params).toMatchObject({ user_id: 42, message: expect.stringContaining("表情列表 2/2") });

      sendOneBot("#表情详情 别名0");
      const oneDetail = await onebot.next("send_msg");
      expect(oneDetail.params).toMatchObject({ user_id: 42, message: [
        { type: "reply" }, { type: "text", data: { text: expect.stringContaining(description) } }, { type: "image" },
      ] });
      expect(imageBytes(oneDetail.params)).toEqual(Uint8Array.fromBase64(bytes));

      await sendMilky("表情详情别名0");
      const otherDetail = await milky.next("send_private_message");
      expect(otherDetail.params).toMatchObject({ user_id: 43, message: [
        { type: "reply" }, { type: "text", data: { text: expect.stringContaining(description) } }, { type: "image" },
      ] });
      expect(imageBytes(otherDetail.params)).toEqual(Uint8Array.fromBase64(bytes));
      otherDetail.respond({ message_seq: 104 });

      expect(requests).toEqual(["GET /source/memes/demo0/preview", "GET /source/memes/demo0/preview"]);
    }, 10_000, 'Bun.env.LOTUS_SKIA_MODE = "gpu";\n', root => catalog(root, new URL("/source/", server.url)));
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
            const initialized = db.query("SELECT 1 FROM sqlite_master WHERE name = 'meme'").get();
            ready = !!initialized && db.query("SELECT 1 FROM meme WHERE key = 'turn'").get() !== null;
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
    }, 10_000, "", async root => {
      await copyMeme(root);
      await symlink(fileURLToPath(new URL("../packages/", import.meta.url)), join(root, "packages"), "dir");
      const config = join(root, "data", "meme", "config");
      await mkdir(config, { recursive: true });
      await writeFile(join(config, "server.yaml"), `backend: managed\nurl: ${remote.url.href}\n`);
    });
  } finally { remote.stop(true); }
}, 20_000);
