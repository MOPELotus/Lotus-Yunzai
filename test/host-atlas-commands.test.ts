import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const token = "atlas-command-fixture";
const excludedCommands = [
  "#风图鉴", "#101", "#未知样例",
  "#西风剑攻略", "*锋镝练度", "#我的深渊战绩",
  "#图鉴西风剑攻略", "#Lotus图鉴重置",
  "#荷花图鉴 西风剑", "#Lotus图鉴 西风剑", "lotus图鉴 西风剑", "荷花图鉴西风剑",
  "#荷花图鉴状态", "lotus图鉴状态", "#Lotus图鉴帮助", "荷花图鉴更新", "#Lotus检查图鉴更新",
];

async function writeCatalog(directory: string) {
  await mkdir(join(directory, "items"), { recursive: true });
  const record = (id: string, name: string, rarity?: string) => ({ id, name, rarity, path: `items/${id}.json` });
  const page = (...records: ReturnType<typeof record>[]) => ({
    version: "1", recordCount: records.length, records: Object.fromEntries(records.map((item) => [item.id, item])),
  });
  const game = (pages: object) => ({ locales: { zh: { pages } } });
  const detail = (gameId: string, pageId: string, recordId: string, content: object) =>
    writeFile(join(directory, "items", `${recordId}.json`), JSON.stringify({
      meta: { gameId, pageId, recordId, version: "1" }, content,
    }));
  await Promise.all([
    writeFile(join(directory, "map.json"), JSON.stringify({ games: {
      gi: game({
        weapon: page(record("101", "西风剑", "四星"), record("102", "共用样例", "五星"), record("104", "更新", "四星")),
        artifact: page(record("103", "103")),
      }),
      hsr: game({ lightcone: page(record("201", "锋镝", "三星"), record("202", "共用样例", "四星")) }),
      zzz: game({ weapon: page(record("301", "深海访客")) }),
    } })),
    detail("gi", "weapon", "101", { list: { type: "WEAPON_SWORD_ONE_HAND" },
      detail: { desc: "西风骑士团的制式长剑。" } }),
    detail("gi", "weapon", "102", { list: { type: "WEAPON_SWORD_ONE_HAND" } }),
    detail("gi", "weapon", "104", { list: { type: "WEAPON_SWORD_ONE_HAND" } }),
    detail("gi", "artifact", "103", {
      list: { set: { sample: { name: { zh: "共用样例" } } } },
      detail: { need: [1], affix: [{ desc: "样例增益。" }] },
    }),
    detail("hsr", "lightcone", "201", { list: { baseType: "Rogue" } }),
    detail("hsr", "lightcone", "202", { list: { baseType: "Rogue" } }),
    detail("zzz", "weapon", "301", { list: { type: 7, rank: 2 } }),
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
      if (part.done) throw new Error(`测试宿主未启动 OneBot：${output}`);
      output += decoder.decode(part.value, { stream: true });
      const endpoint = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
      if (endpoint) return endpoint;
    }
  } finally {
    reader.releaseLock();
  }
}

test("Atlas 传统图鉴指令在实际宿主保留游戏前缀、分类和匹配边界", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-atlas-"));
  const data = join(root, "catalog");
  try {
    await copyHost(root);
    disableMemberPrewarm(root);
    await Promise.all([
      writeCatalog(data),
      writeFile(join(root, "config", "global.yaml"), "atlas: { max_results: 2, auto_update: { enable: false } }\n"),
      cp(new URL("../plugins/atlas/", import.meta.url), join(root, "plugins", "atlas"), {
        recursive: true, filter: (path) => !path.endsWith("/.git") && !path.endsWith("/node_modules"),
      }),
      writeFile(join(root, "plugins", "atlas-fallthrough-fixture.js"), `
        const excluded = new Set(${JSON.stringify(excludedCommands)});
        export default class AtlasFallthroughFixture extends plugin {
          constructor() { super({ event: "message.group" }); }
          async accept(e) {
            if (!excluded.has(e.raw_message)) return false;
            await e.reply("旁路 " + e.raw_message);
            return "return";
          }
        }
      `),
    ]);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token, LOTUS_ATLAS_DATA_DIR: data },
    });
    const stderr = new Response(host.stderr).text();
    let socket: WebSocket | undefined;
    try {
      const endpoint = await deadline(readEndpoint(host.stdout), "图鉴测试宿主启动超时。");
      const WebSocketClient = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
      const client = socket = new WebSocketClient(endpoint, {
        headers: { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": "99" },
      });
      const frames: { action: string; params: { group_id: number; message: string }; echo?: string }[] = [];
      let frameReady = Promise.withResolvers<void>();
      client.addEventListener("message", ({ data }) => {
        frames.push(JSON.parse(data));
        frameReady.resolve();
      });
      await deadline(new Promise<void>((resolve, reject) => {
        client.addEventListener("open", () => resolve(), { once: true });
        client.addEventListener("error", reject, { once: true });
      }), "图鉴测试网关连接超时。");

      let messageId = 0;
      async function query(message: string) {
        expect(frames).toEqual([]);
        client.send(JSON.stringify({ post_type: "message", message_type: "group", sub_type: "normal",
          self_id: 99, user_id: 42, group_id: 77, message_id: ++messageId, message }));
        await deadline(frameReady.promise, `图鉴指令未回复：${message}`);
        const frame = frames.shift();
        expect(frame).toMatchObject({ action: "send_msg", params: { group_id: 77 } });
        frameReady = Promise.withResolvers<void>();
        if (frame?.echo) client.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0,
          data: { message_id: messageId + 1000 } }));
        return frame!.params.message;
      }

      const genshin = "原神 · 武器 · 西风剑 · 四星 · 单手剑 · ID 101";
      const starRail = "星铁 · 光锥 · 锋镝 · 三星 · 巡猎 · ID 201";
      const zenless = "绝区零 · 音擎 · 深海访客 · B级 · 锋御 · ID 301";
      for (const [commands, reply] of [
        [["#图鉴 西风剑", "图鉴 西风剑", "#图鉴西风剑", "#图鉴西风", "#图鉴 西风",
          "#西风剑图鉴", "#西风图鉴", "#101图鉴", "#武器图鉴 原神 西风剑"], genshin],
        [["*锋镝图鉴", "＊锋镝图鉴", "#星穹铁道锋镝图鉴", "*201图鉴", "#光锥图鉴 锋镝"], starRail],
        [["%深海访客图鉴", "％深海访客图鉴", "%访客图鉴", "#绝区零深海访客图鉴", "#音擎图鉴 深海访客"], zenless],
      ] as const) {
        for (const command of commands) expect(await query(command)).toBe(reply);
      }

      const gWeapon = "原神 · 武器 · 共用样例 · 五星 · 单手剑 · ID 102";
      const gSet = "原神 · 圣遗物 · 共用样例 · ID 103";
      const cone = "星铁 · 光锥 · 共用样例 · 四星 · 巡猎 · ID 202";
      expect(await query("#图鉴 西风骑士团的制式长剑")).toBe(genshin);
      expect(await query("#圣遗物图鉴 共用样例")).toBe(`${gSet}\n1件套 · 样例增益。`);
      for (const command of ["#图鉴 共用样例", "#图鉴共用样例"]) {
        const result = await query(command);
        expect(result.split("\n").filter(line => [gWeapon, gSet, cone].includes(line))).toHaveLength(2);
        expect(result).toContain("结果较多");
      }
      const suffixMatch = await query("#共用样例图鉴");
      expect(suffixMatch.split("\n")).toEqual(expect.arrayContaining([gWeapon, gSet]));
      expect(suffixMatch).not.toContain(cone);
      expect(await query("*共用样例图鉴")).toBe(cone);

      for (const command of ["#图鉴状态", "图鉴状态"]) {
        const status: unknown = await query(command);
        expect(status).toEqual([{ type: "image", data: expect.objectContaining({
          file: expect.stringMatching(/^base64:\/\/iVBORw0KGgo/u),
        }) }]);
      }
      expect(await query("图鉴 更新")).toBe("原神 · 武器 · 更新 · 四星 · 单手剑 · ID 104");
      for (const command of ["图鉴更新", "#更新图鉴", "#检查图鉴更新"]) {
        expect(await query(command)).toBe("只有 bot 主人可以操作图鉴更新。");
      }
      expect(await query("#重置图鉴")).toBe("只有 bot 主人可以重置图鉴。");
      expect(await query("清空图鉴")).toBe("只有 bot 主人可以重置图鉴。");
      expect(await query("#全量更新图鉴")).toBe("只有 bot 主人可以操作图鉴更新。");

      for (const command of excludedCommands) expect(await query(command)).toBe(`旁路 ${command}`);

      // The fixture omits the optional local renderer to exercise the textual fallback.
      for (const command of ["#图鉴 未知样例", "#图鉴未知样例", "#未知样例图鉴", "%锋镝图鉴"]) {
        expect(await query(command)).toContain("未找到匹配的图鉴资料");
      }
      expect(await query("#未知样例命座")).toContain("未找到匹配的角色资料");
      expect(await query("#图鉴 本期深渊")).toContain("本期轮换时间待核对");
      expect(await query("#图鉴上期末日2026年2月29日")).toContain("日期无效");

      const recovered = join(data, "items/简体中文/原神/武器/一星");
      await mkdir(recovered, { recursive: true });
      await writeFile(join(recovered, "无锋剑.json"), JSON.stringify({
        meta: { gameId: "gi", gameFolder: "原神", locale: "zh", localeFolder: "简体中文", pageId: "weapon", pageFolder: "武器",
          recordId: "11101", name: "无锋剑", rarity: "一星", version: "7.2.52", sourcePath: "7.2.52/weapon.json",
          sourceUrl: "https://static.nanoka.cc/gi/7.2.52/weapon.json", hasDetail: false, images: [] },
        content: { list: { id: "11101", type: "WEAPON_SWORD_ONE_HAND" }, detail: null },
      }));
      await rm(join(data, "map.json"));
      expect(await query("#图鉴 无锋剑")).toBe("原神 · 武器 · 无锋剑 · 一星 · 单手剑 · ID 11101");
      expect(await Bun.file(join(data, "map.json")).exists()).toBe(false);
      await writeFile(join(data, "map.json"), "{ broken");
      expect(await query("#图鉴 无锋剑")).toContain("图鉴数据不可用");
      expect(frames).toEqual([]);
    } finally {
      socket?.close();
      host.kill();
      try {
        await deadline(host.exited, "图鉴测试宿主退出超时。");
      } finally {
        if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
        await host.exited;
      }
    }
    expect(await stderr).not.toContain("处理 OneBot 来信失败");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
