import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const bytes = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const description = "标签：[旧标签]\n可选参数：[radius: 设置半径]\n参数命令：[大圆]\n预览图片：";

async function catalog(root: string, server: URL) {
  const source = fileURLToPath(new URL("../plugins/meme/", import.meta.url));
  const destination = join(root, "plugins", "meme");
  await cp(source, destination, {
    recursive: true, filter: file => basename(file) !== ".git" && basename(file) !== "node_modules",
  });
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir");
  const data = join(root, "data", "meme");
  const config = join(data, "config");
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "other.yaml"), "autoUpdateRes: false\n");
  await writeFile(join(config, "server.yaml"), `url: ${server.href}\n`);
  const db = new Database(join(data, "data.db"));
  try {
    db.run(`CREATE TABLE meme (key TEXT PRIMARY KEY, keyWords TEXT, min_images INTEGER, max_images INTEGER,
      min_texts INTEGER, max_texts INTEGER, params TEXT, defText TEXT, tags TEXT);
      CREATE TABLE preset (name TEXT PRIMARY KEY, key TEXT);`);
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

test("正常宿主通过 OneBot 和 Milky 返回原列表图样及同源详情图片", async () => {
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
      expect(metadata).toMatchObject({ width: 1440, format: "png" });

      await sendMilky("meme列表");
      const otherList = await milky.next("send_private_message");
      expect(otherList.params).toMatchObject({ user_id: 43, message: [{ type: "image" }] });
      expect(imageBytes(otherList.params)).toEqual(rendered);
      otherList.respond({ message_seq: 102 });

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
    }, 5_000, 'Bun.env.LOTUS_SKIA_MODE = "gpu";\n', root => catalog(root, new URL("/source/", server.url)));
  } finally { server.stop(true); }
}, 15_000);
