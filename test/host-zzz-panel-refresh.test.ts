import { expect, test } from "bun:test";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const uid = "82521042";
const region = "prod_gf_cn";
const roleInterval = 180;

const preload = `
import { appendFileSync } from "node:fs";
const nativeFetch = globalThis.fetch;
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
Bun.env.LOTUS_ZZZ_LEGACY_RESOURCES_DIR = "./legacy/resources";
Bun.env.LOTUS_SKIA_MODE = "gpu";
const legacyKey = "ZZZ:PANEL:${uid}:LASTTIME";
const modernKey = "lotus-yunzai:zzz-panel:last-refresh:${region}:${uid}";
const previous = String(Date.now());
function traceKey(operation, key) {
  if (key === legacyKey || key === modernKey) appendFileSync("panel-timestamps.log", operation + " " + key + "\\n");
}
globalThis.redis = {
  async get(key) { traceKey("get", key); return key === legacyKey || key === modernKey ? previous : null; },
  async set(key) { traceKey("set", key); return "OK"; },
  async hGetAll() { return {}; },
  async hGet() { return null; },
  async mGet(keys) { return keys.map(() => null); },
};
const uid = "${uid}", region = "${region}", game_biz = "nap_cn";
const rows = new Map([[1041, "「11号」"], [1141, "莱卡恩"]]);
let first = true;
globalThis.fetch = Object.assign(async (address, options) => {
  const url = new URL(address instanceof Request ? address.url : String(address));
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return nativeFetch(address, options);
  if (url.hostname === "q1.qlogo.cn") return new Response(null, { status: 404 });
  if (url.origin !== "https://api-takumi-record.mihoyo.com" || url.searchParams.get("role_id") !== uid ||
      url.searchParams.get("server") !== region || new Headers(options?.headers).get("cookie") !== "cookie_token=synthetic") {
    throw new Error("隔离禁止非样本请求。");
  }
  const part = url.pathname.split("/").at(-1);
  const id = Number(url.searchParams.get("id_list[]"));
  appendFileSync("panel-requests.jsonl", JSON.stringify([part, id, performance.now()]) + "\\n");
  if (part === "basic") {
    if (first) {
      first = false;
      const until = performance.now() + 4000;
      while (!await Bun.file("./release-panel").exists()) {
        if (performance.now() > until) throw new Error("隔离等待超时");
        await Bun.sleep(10);
      }
    }
    return Response.json({ retcode: 0, data: { uid, region, game_biz, avatar_list: [...rows.keys()].map(id => ({ id })) } });
  }
  if (part !== "info" || !rows.has(id)) throw new Error("隔离角色不在样本。");
  return Response.json({ retcode: 0, data: { uid, region, game_biz, avatar_list: [
    { id, name_mi18n: rows.get(id), rarity: "S", rank: 0, level: 60 },
  ] } });
}, { preconnect: nativeFetch.preconnect });
`;

async function prepare(root: string) {
  const source = join(import.meta.dir, "..", "plugins", "zzz");
  const destination = join(root, "plugins", "zzz");
  await cp(source, destination, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir");
  const profiles = join(root, "profiles");
  await mkdir(profiles);
  await writeFile(join(profiles, "42-2.yaml"), Bun.YAML.stringify({
    device: { id: "fixture-panel-device", fp: "0123456789abc", bound: true },
    user: { qq: "42" }, profile: { id: 2 }, account: { cookie: "cookie_token=synthetic", stoken: "fixture",
      stuid: "82", game_roles: { zzz: [{ uid, region, game_biz: "nap_cn" }] }, current_uid: { zzz: uid } },
  }));
  const maps = join(root, "legacy", "resources", "map");
  await mkdir(maps, { recursive: true });
  await writeFile(join(maps, "PartnerId2Data.json"), JSON.stringify({ "1041": { name: "「11号」" } }));
  await writeFile(join(root, "config", "zzz-panel.yaml"), `interval: 3600\nroleInterval: ${roleInterval}\n`);
}

type RequestTrace = [part: string, avatar: number, at: number];

test("绝区零各手动面板更新连续触发；同 UID 在途仍拦，逐角色保留间隔", async () => {
  await withDualGatewayFixture("zzz-manual-panel-refresh", "disablePrivate: false\n",
    async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
      let nextId = 151;
      const requestsFile = join(root, "panel-requests.jsonl");
      const requests = async (): Promise<RequestTrace[]> => (await readFile(requestsFile, "utf8")).trim().split("\n")
        .map(line => JSON.parse(line));
      async function begin(message: string, named = false) {
        sendOneBot(message);
        const progress = await onebot.next("send_msg");
        expect(JSON.stringify(progress.params)).toContain(named ? "正在更新11号面板" : "正在更新面板列表");
        progress.respond({ message_id: nextId++ });
      }
      async function finish() {
        const sent = await onebot.next("send_msg");
        const body = JSON.stringify(sent.params);
        expect(body.includes('"type":"image"') || body.includes("绝区零面板已更新")).toBe(true);
        sent.respond({ message_id: nextId++ });
      }
      await begin("%更新面板2");
      const until = performance.now() + 2000;
      while (!await Bun.file(requestsFile).exists() && performance.now() < until) await Bun.sleep(10);
      expect((await requests()).map(row => row[0])).toEqual(["basic"]);
      await sendMilky("#绝区零刷新面板2", { sender_id: 42, peer_id: 42 });
      const busy = await milky.next("send_private_message");
      expect(JSON.stringify(busy.params)).toContain("绝区零面板正在更新");
      busy.respond({ message_seq: nextId++ });
      expect((await requests()).map(row => row[0])).toEqual(["basic"]);
      await writeFile(join(root, "release-panel"), "");
      await finish();

      for (const command of ["#绝区零面板更新2", "%全部面板更新2", "%更新全部面板2", "%刷新面板2", "%面板刷新2"]) {
        await begin(command);
        await finish();
      }
      await begin("%更新11号面板2", true);
      await finish();

      const observed = await requests();
      expect(observed).toHaveLength(19);
      for (let i = 0; i < 18; i += 3) {
        const batch = observed.slice(i, i + 3);
        expect(batch.map(([part, id]) => [part, id])).toEqual([["basic", 0], ["info", 1041], ["info", 1141]]);
        expect(batch[2]![2] - batch[1]![2]).toBeGreaterThanOrEqual(roleInterval - 20);
      }
      expect(observed[18]?.slice(0, 2)).toEqual(["info", 1041]);
      expect(await Bun.file(join(root, "panel-timestamps.log")).exists()).toBe(false);
      expect(await readFile(join(root, "config", "zzz-panel.yaml"), "utf8")).toContain("interval: 3600");
    }, 8_000, preload, prepare);
}, 35_000);
