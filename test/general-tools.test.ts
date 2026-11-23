import { expect, test } from "bun:test";
import { CommandRegistry, sendCommandReply } from "../lib/commands.ts";
import { generalToolCommands } from "../lib/general-tools.ts";
import type { MessageReply } from "../lib/messages.ts";

const group = { message_type: "group", isMaster: false } as const;
const picture = new Uint8Array([255, 216, 255, 217]);
const imageResponse = () => new Response(picture, { headers: { "content-type": "image/jpeg" } });

test("猫图从两处独立读取，失败源不拦截剩余合并转发，不透传图片 URL", async () => {
  const visited: string[] = [];
  const module = generalToolCommands(new AbortController().signal, async (url, init) => {
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
    visited.push(url.href);
    if (url.hostname === "shibe.online") throw new Error("TLS unavailable");
    if (url.hostname === "api.thecatapi.com") {
      return Response.json([
        { url: "https://cdn2.thecatapi.com/images/cat.jpg" },
        { url: "http://cdn2.thecatapi.com/unsafe.jpg" },
        { url: "https://cdn2.thecatapi.com:8443/rejected.jpg" },
        { url: "https://cdn2.thecatapi.com@localhost/private.jpg" },
        { url: "https://cdn2.thecatapi.com/images/cat.jpg" },
      ]);
    }
    return imageResponse();
  });
  const commands = new CommandRegistry();
  commands.registerModule(module);
  const result = await commands.dispatch("#cat", group);
  expect(visited).toEqual([
    "https://shibe.online/api/cats?count=10",
    "https://api.thecatapi.com/v1/images/search?limit=10",
    "https://cdn2.thecatapi.com/images/cat.jpg",
  ]);
  expect(result).toEqual({ type: "forward", nodes: [{ type: "image", file: picture }], batchSize: 5, senderName: "猫图" });
  const delivered: (readonly MessageReply[])[] = [];
  if (result) {
    await sendCommandReply({
      forward: async nodes => { delivered.push(nodes); return true; },
      reply: () => { throw new Error("应使用合并转发"); },
    }, result);
  }
  expect(delivered).toEqual([[{ type: "image", file: picture }]]);
});

test("群聊限定和生命周期生效，超限及非法图片得到可读的失败回执", async () => {
  const controller = new AbortController();
  const visited: string[] = [];
  const commands = new CommandRegistry();
  commands.registerModule(generalToolCommands(controller.signal, async url => {
    visited.push(url.hostname);
    if (url.hostname === "shibe.online") return Response.json(["https://cdn.shibe.online/test.jpg"]);
    if (url.hostname === "api.thecatapi.com") return Response.json([]);
    return imageResponse();
  }));
  expect(await commands.dispatch("#cat", { ...group, message_type: "private" })).toEqual([]);
  expect(await commands.dispatch("#cat 1", group)).toEqual([]);
  expect(await commands.dispatch("#cat", { ...group, isDelegated: true })).toEqual([]);
  expect(visited).toEqual([]);
  expect(await commands.dispatch("#cat", { ...group, inlineImageByteLimit: 3 })).toContain("暂时无法获取");
  expect(await commands.dispatch("#cat", group)).toEqual({
    type: "forward", nodes: [{ type: "image", file: picture }], batchSize: 5, senderName: "猫图",
  });
  expect(visited).toEqual(["shibe.online", "api.thecatapi.com", "cdn.shibe.online", "shibe.online", "api.thecatapi.com", "cdn.shibe.online"]);
  controller.abort();
  expect(await commands.dispatch("#cat", group)).toEqual([]);
  expect(visited).toHaveLength(6);
});

test("软件各平台独立降级，保留有效项并过滤跨域链接", async () => {
  const sources: string[] = [];
  const commands = new CommandRegistry();
  commands.registerModule(generalToolCommands(new AbortController().signal, async url => {
    sources.push(url.href);
    if (url.searchParams.get("n") === "and") return new Response("outage", { status: 503 });
    if (url.searchParams.get("n") === "pc") return Response.json({
      code: 200,
      data: { list: [
        { title: "笔记\n 工具", url: "https://www.ghxi.com/joplin.html" },
        { title: "无关站点", url: "https://evil.example/" },
      ] },
    });
    throw new Error("未知图源");
  }));
  expect(await commands.dispatch("#推荐软件", group)).toEqual({
    type: "forward", nodes: ["电脑推荐软件：笔记  工具\n地址：https://www.ghxi.com/joplin.html"], batchSize: 20, senderName: "推荐软件",
  });
  expect(sources).toEqual(["https://www.ghxi.com/ghapi?type=query&n=pc", "https://www.ghxi.com/ghapi?type=query&n=and"]);
});
