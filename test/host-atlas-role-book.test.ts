import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

type Game = "gi" | "hsr" | "zzz";
const token = "atlas-role-book-fixture";
const passthrough = ["#芙宁娜攻略", "#芙宁", "*卡芙卡影画", "*我的卡芙卡星魂", "#西风剑天赋"];
const sections = {
  gi: ["角色总览", "技能与天赋", "命座", "养成材料"],
  hsr: ["角色总览", "技能与天赋", "星魂"],
  zzz: ["角色总览", "技能与天赋", "影画", "养成材料"],
} as const;

async function writeCatalog(directory: string) {
  await mkdir(join(directory, "items"), { recursive: true });
  const record = (id: string, name: string, rarity: string) => ({ id, name, rarity, path: `items/${id}.json` });
  const page = (item: ReturnType<typeof record>) => ({ version: "1", recordCount: 1, records: { [item.id]: item } });
  const detail = (gameId: Game, pageId: string, id: string, content: object) =>
    writeFile(join(directory, "items", `${id}.json`), JSON.stringify({
      meta: { gameId, pageId, recordId: id, version: "1" }, content,
    }));
  await Promise.all([
    writeFile(join(directory, "map.json"), JSON.stringify({ games: {
      gi: { locales: { zh: { pages: {
        character: page(record("101", "芙宁娜", "五星")), weapon: page(record("201", "西风剑", "四星")),
      } } } },
      hsr: { locales: { zh: { pages: { character: page(record("102", "卡芙卡", "五星")) } } } },
      zzz: { locales: { zh: { pages: { character: page(record("103", "艾莲", "S级")) } } } },
    } })),
    detail("gi", "character", "101", { detail: {
      desc: "原神夹具简介", skills: [{ name: "技能甲", desc: "技能描述" }],
      constellations: [{ name: "命座甲", desc: "命座效果" }],
      materials: { ascensions: [{ mats: [{ id: 11, name: "材料甲", count: 2 }] }] },
    } }),
    detail("hsr", "character", "102", { detail: {
      desc: "星铁夹具简介", skills: { "10201": { name: "技能乙", type: "Normal", type_name: "普攻", desc: "技能描述" } },
      ranks: { "1": { name: "星魂甲", desc: "星魂效果" } },
    } }),
    detail("zzz", "character", "103", { list: { rank: 4 }, detail: {
      partner_info: { profile_desc: "绝区零夹具简介" },
      skill: { basic: { description: [{ name: "技能丙", desc: "技能描述" }] } },
      talent: { "1": { level: 1, name: "影画甲", desc: "影画效果" } },
      level: { "1": { materials: { "11": 3 } } },
    } }),
    detail("gi", "weapon", "201", { list: { type: "WEAPON_SWORD_ONE_HAND" } }),
  ]);
}

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function readEndpoint(stdout: ReadableStream<Uint8Array>) {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) throw new Error(`角色图册测试宿主未启动 OneBot。\n${output}`);
      output += decoder.decode(part.value, { stream: true });
      const endpoint = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
      if (endpoint) return endpoint;
    }
  } finally {
    reader.releaseLock();
  }
}

test("Atlas 角色图册按角色和游戏精确路由并按分组顺序合并转发", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-atlas-role-book-"));
  const data = join(root, "catalog");
  const atlas = join(root, "plugins", "atlas");
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let socket: WebSocket | undefined;
  try {
    await copyHost(root);
    disableMemberPrewarm(root);
    for (const [game, aliases] of [["gs", { 芙宁娜: "芙宁,水神" }], ["sr", { 卡芙卡: "卡芙" }]] as const) {
      const directory = join(root, "resources", "builtin", "games", "miao", `meta-${game}`, "character");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "alias.js"), `export const alias = ${JSON.stringify(aliases)};`);
    }
    await mkdir(join(root, "config", "character-aliases"), { recursive: true });
    await writeFile(join(root, "config", "character-aliases", "alias_gs.cfg"), "芙宁娜: 剧院水舞者\n");
    const material = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9uoAAAAASUVORK5CYII=", "base64");
    const materialRoot = join(root, "temp", "material");
    await Promise.all([mkdir(join(materialRoot, "gs", "友人A"), { recursive: true }),
      mkdir(join(materialRoot, "sr", "小橙子啊"), { recursive: true })]);
    await Promise.all([
      writeCatalog(data),
      writeFile(join(materialRoot, "gs", "友人A", "刻晴.jpg"), material),
      writeFile(join(materialRoot, "sr", "小橙子啊", "符玄.jpg"), material),
      cp(new URL("../plugins/atlas/", import.meta.url), atlas, {
        recursive: true, filter: (path) => !path.endsWith("/.git") && !path.endsWith("/node_modules"),
      }),
      cp(new URL("../plugins/guides/", import.meta.url), join(root, "plugins", "guides"), {
        recursive: true, filter: (path) => !path.endsWith("/.git") && !path.endsWith("/node_modules"),
      }),
      writeFile(join(root, "plugins", "role-book-fallthrough-fixture.js"), `
        const commands = new Set(${JSON.stringify(passthrough)});
        export default class RoleBookFallthrough extends plugin {
          constructor() { super({ event: "message.group" }); }
          async accept(e) {
            if (!commands.has(e.raw_message)) return false;
            await e.reply("旁路 " + e.raw_message);
            return "return";
          }
        }
      `),
    ]);
    await writeFile(join(root, "offline.ts"), `
      const original = fetch;
      globalThis.fetch = Object.assign((input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.protocol === "http:" && url.hostname === "127.0.0.1") return original(input, init);
        throw new Error("角色图册离线夹具禁止访问公网");
      }, { preconnect: original.preconnect });
    `);
    // Exercise host delivery without launching a renderer in the copied project.
    await writeFile(join(atlas, "role-render.ts"), `
      export async function renderRoleBook(role, { assetRoot }, view) {
        if (assetRoot !== process.env.LOTUS_ATLAS_DATA_DIR) throw new Error("fixture: wrong asset root");
        const ranks = { gi: "命座", hsr: "星魂", zzz: "影画" };
        const pages = ["角色总览"];
        if (role.skills.some(({ cards }) => cards.length)) pages.push("技能与天赋");
        if (role.ranks.length) pages.push(ranks[role.game]);
        if (role.materials.some(({ items }) => items.length)) pages.push("养成材料");
        return pages.map((section, index) => ({ section, engine: "fixture",
          png: new Uint8Array([Number(role.id), index + 1]),
        })).filter(({ section }) => !view || section === (view === "ranks" ? ranks[role.game] : "技能与天赋"));
      }
    `);
    host = Bun.spawn([process.execPath, "--preload", "./offline.ts", "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token, LOTUS_ATLAS_DATA_DIR: data,
        LOTUS_GUIDES_AUTO_UPDATE: "0" },
    });
    const stderr = new Response(host.stderr).text();
    const endpoint = await deadline(readEndpoint(host.stdout), "角色图册测试宿主启动超时。");
    const WebSocketClient = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const client = socket = new WebSocketClient(endpoint, {
      headers: { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": "99" },
    });
    const frames: { action: string; echo?: string; params: { message?: string; messages?: readonly object[] } }[] = [];
    let ready = Promise.withResolvers<void>();
    client.addEventListener("message", ({ data }) => {
      frames.push(JSON.parse(data));
      ready.resolve();
    });
    await deadline(new Promise<void>((resolve, reject) => {
      client.addEventListener("open", () => resolve(), { once: true });
      client.addEventListener("error", reject, { once: true });
    }), "角色图册测试网关连接超时。");
    let messageId = 0;
    async function next(command: string) {
      if (!frames.length) await deadline(ready.promise, `角色图册指令未回复：${command}`);
      const frame = frames.shift()!;
      if (!frames.length) ready = Promise.withResolvers<void>();
      return frame;
    }
    function send(message: string, group = true) {
      client.send(JSON.stringify({ post_type: "message", message_type: group ? "group" : "private",
        self_id: 99, user_id: 42, message, message_id: ++messageId,
        ...(group ? { group_id: 77, sub_type: "normal" } : { sub_type: "friend" }),
      }));
    }
    async function book(command: string, [game, id, name]: readonly [Game, number, string], group = true, retcode = 0) {
      send(command, group);
      const frame = await next(command);
      expect(frame).toMatchObject(group ? { action: "send_group_forward_msg", params: { group_id: 77 } }
        : { action: "send_private_forward_msg", params: { user_id: 42 } });
      const pages = sections[game];
      const title = `${name}完整图鉴\n${pages.join(" → ")}\n共 ${pages.length} 页`;
      const contents = [{ type: "text", data: { text: title } }, ...pages.map((_, index) => ({
        type: "image", data: { file: `base64://${Buffer.from([id, index + 1]).toString("base64")}` },
      }))];
      expect(frame.params.messages).toEqual(contents.map((part) => ({
        type: "node", data: { uin: "99", name: "Lotus-Yunzai", content: [part] },
      })));
      expect(typeof frame.echo).toBe("string");
      client.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode, data: { message_id: 800 + messageId } }));
    }
    async function section(command: string, id: number, page: number) {
      send(command);
      const frame = await next(command);
      expect(frame).toMatchObject({ action: "send_msg", params: { group_id: 77, message: [
        { type: "image", data: { file: `base64://${Buffer.from([id, page]).toString("base64")}` } },
      ] } });
      if (frame.echo) client.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: { message_id: 800 + messageId } }));
    }

    const furina = ["gi", 101, "芙宁娜"] as const;
    const kafka = ["hsr", 102, "卡芙卡"] as const;
    const ellen = ["zzz", 103, "艾莲"] as const;
    await book("#图鉴 原神 芙宁娜", furina);
    await book("#芙宁娜图鉴", furina);
    await book("#芙宁图鉴", furina);
    await book("#水神图鉴", furina);
    await book("#剧院水舞者图鉴", furina);
    await section("#芙宁娜命座", 101, 3);
    await section("#芙宁娜命之座", 101, 3);
    await section("#芙宁娜技能", 101, 2);
    await section("*卡芙卡行迹", 102, 2);
    await section("*卡芙卡星魂", 102, 3);
    await section("*卡芙星魂", 102, 3);
    await section("#星穹铁道卡芙卡星魂图鉴", 102, 3);
    await book("%艾莲影画", ellen);
    await book("#绝区零艾莲影画", ellen);
    await book("图鉴 绝区零 艾莲", ellen, false);
    for (const [command, group] of [["#刻晴素材", true], ["*符玄突破", false]] as const) {
      send(command, group);
      const frame = await next(command);
      expect(frame).toMatchObject({ action: "send_msg", params: {
        ...(group ? { group_id: 77 } : { user_id: 42 }),
        message: [{ type: "image", data: expect.objectContaining({ file: `base64://${material.toString("base64")}` }) }],
      } });
      if (frame.echo) client.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: { message_id: 800 + messageId } }));
    }
    await book("*卡芙卡图鉴", kafka, true, 1);
    expect(await next("未确认回执")).toMatchObject({ action: "send_msg", params: {
      group_id: 77, message: "合并转发结果未确认，请在聊天中核对。",
    } });
    for (const command of passthrough) {
      send(command);
      expect(await next(command)).toMatchObject({ action: "send_msg", params: { group_id: 77, message: `旁路 ${command}` } });
    }
    expect(frames).toEqual([]);
    host.kill();
    await deadline(host.exited, "角色图册测试宿主退出超时。");
    expect(await stderr).not.toContain("处理 OneBot 来信失败");
  } finally {
    socket?.close();
    if (host && host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    await host?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
