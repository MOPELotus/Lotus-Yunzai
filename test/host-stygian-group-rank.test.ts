import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const proof = Bun.env.LOTUS_STYGIAN_HOST_PROOF;
const themeSource = Bun.env.LOTUS_STYGIAN_THEME_FIXTURE;
const valkey = Bun.which("valkey-server");
const group = 701;
const current = "6.4";
const old = "6.0";
const fakeUid = { 42: "100000042", 43: "100000043", 44: "100000044", 45: "100000045" } as const;
const skiaEntry = join(import.meta.dir, "../packages/skia/node_modules/skia-canvas/lib/index.js");
const preload = `
import { appendFile } from "node:fs/promises";
import { Canvas } from ${JSON.stringify(skiaEntry)};
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
Bun.env.VK_DRIVER_FILES = "/usr/share/vulkan/icd.d/nvidia_icd.json";
const originalToBuffer = Canvas.prototype.toBuffer;
Canvas.prototype.toBuffer = async function (...args) {
  const output = await originalToBuffer.apply(this, args);
  const engine = this.engine;
  const device = String(engine.device);
  if (engine.renderer !== "GPU" || engine.api !== "Vulkan" || !device.includes("RTX A4000")) {
    await Bun.write("./unverified-engine.json", JSON.stringify(engine));
    throw Error("群榜必须使用 RTX A4000 Vulkan 实际出图");
  }
  await appendFile("./engine.jsonl", JSON.stringify({ ...engine, device }) + "\\n");
  return output;
};
const nativeFetch = globalThis.fetch;
const uid = ${JSON.stringify(fakeUid)};
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1") return nativeFetch(input, options);
  const headers = new Headers(options?.headers);
  const privacy = options?.credentials === "omit" && options?.redirect === "error" && !headers.has("cookie") && !headers.has("authorization");
  async function record(data) { await appendFile("./requests.jsonl", JSON.stringify({ privacy, ...data }) + "\\n"); }
  if (url.href === "https://ark.ivny.cn/rank/stygian" && options?.method === "POST") {
    const body = JSON.parse(options.body);
    await record({ site: "ark", body });
    if (!privacy || Object.keys(body).sort().join(",") !== "uid,version" || body.version !== "2.1.0" ||
        !Array.isArray(body.uid) || body.uid.length !== 1) return new Response(null, { status: 400 });
    if (body.uid[0] === uid[42]) return Response.json({ retcode: 100, data: [{ uid: uid[42], time: 48, hard: 6, rank: 12, sum: 602 }] });
    if (body.uid[0] === uid[43]) return new Response(null, { status: 503 });
    return new Response(null, { status: 400 });
  }
  if (url.origin === "https://akasha.cv" && url.pathname === "/api/leaderboards/stygian" && options?.method === "GET") {
    const fields = Object.fromEntries(url.searchParams);
    await record({ site: "akasha", fields });
    const { uids, uid: extra, order, size, version } = fields;
    if (!privacy || extra !== "" || !["6_4", "6_0"].includes(version)) return new Response(null, { status: 400 });
    if (!uids && order === "1" && size === "1") return Response.json({ data: [{ index: 912 }] });
    if (order !== "-1" || size !== "50") return new Response(null, { status: 400 });
    if (uids === "[uid]" + uid[43] && version === "6_0") return Response.json({ data: [] });
    if (uids === "[uid]" + uid[43] || uids === "[uid]" + uid[44]) {
      return Response.json({ data: [{ uid: uids.slice(5), stygianIndex: 5, stygianSeconds: 23, index: 71 }] });
    }
    return new Response(null, { status: 400 });
  }
  await record({ site: "blocked", origin: url.origin, path: url.pathname });
  throw Error("隔离群榜不允许其他外联");
};
`;

async function prepare(root: string, redis: { port: number; password: string }) {
  const source = join(import.meta.dir, "../plugins/genshin");
  const plugin = join(root, "plugins/genshin");
  await cp(source, plugin, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
  await symlink(join(source, "node_modules"), join(plugin, "node_modules"), "dir");
  await symlink(join(import.meta.dir, "../packages"), join(root, "packages"), "dir");
  await mkdir(join(root, "profiles"));
  for (const [qq, uid] of Object.entries(fakeUid)) {
    await writeFile(join(root, "profiles", `${qq}.yaml`), Bun.YAML.stringify({
      user: { qq }, profile: { id: 1 }, account: { cookie: `account_id=${qq}; cookie_token=fixture-${qq}`,
        stuid: qq, stoken: "simulated", current_uid: { gs: uid }, game_roles: { gs: [{ uid, region: "cn_gf01", game_biz: "hk4e_cn" }] } },
    }));
  }
  await writeFile(join(root, "config/redis.yaml"), Bun.YAML.stringify({ host: "127.0.0.1", ...redis }));
  const theme = join(root, "data/genshin/miao-theme");
  for (const file of ["common/bg/bg-hydro.webp", "common/cont/card-bg.png", "character/imgs/mark-icon.png",
    "common/font/NZBZ.woff", "common/font/HYWH-65W.woff", "common/font/tttgbnumber.woff"]) {
    const local = join(theme, file);
    await mkdir(dirname(local), { recursive: true });
    await cp(join(themeSource!, file), local);
  }
  const calendar = join(theme, "meta-gs/info/pool.js");
  await mkdir(dirname(calendar), { recursive: true });
  const from = new Date(Date.now() - 8 * 86400_000).toISOString();
  await writeFile(calendar, `export const poolDetail = [{ version: '${current}', half: '上半', from: '${from}' }];\nexport const mixPoolDetail = [];\n`);
}

type Transmission = { readonly action: string; readonly params: Record<string, unknown>; respond(data: unknown): void };
type Queue = { readonly calls: readonly Transmission[]; next(action: string): Promise<Transmission> };
const groupMembers = [42, 43, 44, 45, 99, 100];
const names: Readonly<Record<number, string>> = { 42: "仅 Ark 的群成员", 43: "双站群成员", 44: "仅 Akasha 的群成员", 45: "未授权群成员" };

async function nextReply(queue: Queue, protocol: "onebot" | "milky", messageAction: string) {
  const end = performance.now() + 15_000;
  while (performance.now() < end) {
    const action = queue.calls[0]?.action;
    if (!action) { await Bun.sleep(5); continue; }
    const request = await queue.next(action);
    if (action === messageAction) {
      if (!JSON.stringify(request.params).includes("欢迎使用【Lotus-Yunzai】")) return request;
      request.respond(protocol === "onebot" ? { message_id: 899 } : { message_seq: 899 });
      continue;
    }
    expect(request.params.group_id).toBe(group);
    expect(request.params.no_cache).toBeTrue();
    if (action === "get_group_member_info") {
      const actor = request.params.user_id;
      if (typeof actor !== "number") throw Error("群成员核验缺少 QQ 号");
      expect(groupMembers).toContain(actor);
      const member = { group_id: group, user_id: actor, role: "member" };
      request.respond(protocol === "onebot" ? member : { member });
    } else if (action === "get_group_member_list") {
      const members = groupMembers.map(user_id => ({ group_id: group, user_id, role: "member", nickname: names[user_id] ?? "测试机器人" }));
      request.respond(protocol === "onebot" ? members : { members });
    } else throw Error(`未预期的夹具协议调用 ${action}`);
  }
  throw Error(`没有收到 ${protocol} ${messageAction}`);
}

async function lines(root: string, name: string): Promise<unknown[]> {
  const file = Bun.file(join(root, name));
  return await file.exists() ? (await file.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}

function imageBytes(params: unknown) {
  const data = /base64:\/\/([A-Za-z0-9+/]+={0,2})/u.exec(JSON.stringify(params))?.[1];
  expect(data).toBeDefined();
  return Uint8Array.fromBase64(data!);
}

const arkRequest = (who: 42 | 43) => ({ site: "ark", privacy: true, body: { uid: [fakeUid[who]], version: "2.1.0" } });
const akashaRequest = (who: 43 | 44 | undefined, period = current) => ({ site: "akasha", privacy: true, fields: {
  sort: "stygianScore", order: who === undefined ? "1" : "-1", size: who === undefined ? "1" : "50",
  page: "1", uids: who === undefined ? "" : `[uid]${fakeUid[who]}`, p: "", fromId: "", li: "", uid: "", version: period.replace(".", "_"),
} });

test.skipIf(!proof || !themeSource || !valkey)("幽境群榜从双协议真实宿主确认授权、隔离出站和撤回，在物理显卡发送当前及历史榜图", async () => {
  const storage = await mkdtemp(join(tmpdir(), "lotus-stygian-board-valkey-"));
  const portReservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = portReservation.port;
  portReservation.stop(true);
  const password = crypto.randomUUID();
  const server = Bun.spawn([valkey!, "--bind", "127.0.0.1", "--port", String(port), "--requirepass", password,
    "--save", "", "--appendonly", "no", "--dir", storage], { stdout: "ignore", stderr: "ignore" });
  const db = new Bun.RedisClient(`redis://:${password}@127.0.0.1:${port}`, { autoReconnect: false });
  try {
    for (let tries = 0;; tries++) {
      try { await db.connect(); break; } catch (error) {
        if (tries === 40) throw error;
        await Bun.sleep(20);
      }
    }
    await db.send("ZADD", [`ark-plugin:stygianRank:54:${group}`, "67", fakeUid[43], "12", fakeUid[45]]);
    await withDualGatewayFixture("genshin-stygian-host-fixture", 'master: ["99:42", "100:43"]\ndisablePrivate: false\n',
      async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
        const groupContext = { message_type: "group", sub_type: "normal", group_id: group };
        const fromMilkyGroup = { message_scene: "group", peer_id: group };
        let receipts = 900;
        const respond = (reply: Transmission, protocol: "onebot" | "milky") =>
          reply.respond(protocol === "onebot" ? { message_id: ++receipts } : { message_seq: ++receipts });
        async function authorize(protocol: "onebot" | "milky", actor: number, site: string, early = false) {
          const command = `#幽境群榜授权 ${group} ${site}`;
          const queue = protocol === "onebot" ? onebot : milky;
          const action = protocol === "onebot" ? "send_msg" : "send_private_message";
          async function send(text: string) {
            if (protocol === "onebot") sendOneBot(text, { user_id: actor });
            else expect((await sendMilky(text)).status).toBe(200);
          }
          await send(command);
          const prompt = await nextReply(queue, protocol, action);
          const text = JSON.stringify(prompt.params);
          expect(prompt.params.user_id).toBe(actor);
          expect(text).toContain(fakeUid[actor as keyof typeof fakeUid]);
          expect(text).toContain("难度、用时和排名");
          const confirmation = /#幽境群榜确认 701 \d{6}/u.exec(text)?.[0];
          expect(confirmation).toBeDefined();
          if (early) {
            await send(confirmation!);
            const denied = await nextReply(queue, protocol, action);
            expect(JSON.stringify(denied.params)).toContain("没有匹配的待确认授权");
            respond(denied, protocol);
          }
          respond(prompt, protocol);
          await Bun.sleep(20);
          await send(confirmation!.replace(/^#/u, "#原神"));
          const confirmed = await nextReply(queue, protocol, action);
          expect(JSON.stringify(confirmed.params)).toContain("已确认群 701");
          respond(confirmed, protocol);
        }
        await authorize("onebot", 42, "Ark", true);
        await authorize("onebot", 44, "Akasha");
        await authorize("milky", 43, "双站");
        expect(await lines(root, "requests.jsonl")).toEqual([]);

        sendOneBot("#幽境危战排名", groupContext);
        const oneBoard = await nextReply(onebot, "onebot", "send_msg");
        expect(oneBoard.params.group_id).toBe(group);
        const oneImage = imageBytes(oneBoard.params);
        const dualSize = await new Bun.Image(oneImage).metadata();
        expect(dualSize).toMatchObject({ width: 4816, format: "png" });
        respond(oneBoard, "onebot");
        const oneTrace = await lines(root, "requests.jsonl");
        expect(oneTrace).toHaveLength(3);
        expect(oneTrace).toEqual(expect.arrayContaining([arkRequest(42), akashaRequest(44), akashaRequest(undefined)]));

        expect((await sendMilky("#幽境危战排名", fromMilkyGroup)).status).toBe(200);
        const failedSiteBoard = await nextReply(milky, "milky", "send_group_message");
        expect(failedSiteBoard.params.group_id).toBe(group);
        const failedSiteImage = imageBytes(failedSiteBoard.params);
        const failedSiteSize = await new Bun.Image(failedSiteImage).metadata();
        expect(failedSiteSize).toMatchObject({ width: 4816, format: "png" });
        expect(failedSiteSize.height).toBeLessThan(dualSize.height);
        respond(failedSiteBoard, "milky");
        const currentTrace = (await lines(root, "requests.jsonl")).slice(3);
        expect(currentTrace).toHaveLength(3);
        expect(currentTrace).toEqual(expect.arrayContaining([arkRequest(43), akashaRequest(43), akashaRequest(undefined)]));

        expect((await sendMilky(`#top幽境危战排名 ${old}`, fromMilkyGroup)).status).toBe(200);
        const oldBoard = await nextReply(milky, "milky", "send_group_message");
        const oldImage = imageBytes(oldBoard.params);
        expect(await new Bun.Image(oldImage).metadata()).toMatchObject({ width: 4032, format: "png" });
        respond(oldBoard, "milky");
        const history = await lines(root, "requests.jsonl");
        expect(history.slice(6)).toHaveLength(2);
        expect(history.slice(6)).toEqual(expect.arrayContaining([akashaRequest(43, old), akashaRequest(undefined, old)]));

        expect((await sendMilky(`#幽境群榜撤回 ${group}`)).status).toBe(200);
        const revoked = await nextReply(milky, "milky", "send_private_message");
        expect(JSON.stringify(revoked.params)).toContain("已撤回");
        respond(revoked, "milky");
        expect((await sendMilky("#幽境危战排名6.4", fromMilkyGroup)).status).toBe(200);
        const noBoard = await nextReply(milky, "milky", "send_group_message");
        expect(JSON.stringify(noBoard.params)).toContain("本群暂无已授权成员");
        respond(noBoard, "milky");
        expect(await lines(root, "requests.jsonl")).toEqual(history);

        const engines = await lines(root, "engine.jsonl");
        expect(engines).toHaveLength(3);
        for (const engine of engines) {
          const observed = engine as Record<string, unknown>;
          expect(observed.renderer).toBe("GPU");
          expect(observed.api).toBe("Vulkan");
          expect(observed.device).toContain("RTX A4000");
        }
        await mkdir(proof!, { recursive: true });
        await Promise.all([
          Bun.write(join(proof!, "onebot-dual-source.png"), oneImage),
          Bun.write(join(proof!, "milky-one-source-failed.png"), failedSiteImage),
          Bun.write(join(proof!, "milky-history-legacy.png"), oldImage),
          Bun.write(join(proof!, "verification.json"), JSON.stringify({ engines, requests: history }, null, 2) + "\n"),
        ]);
      }, 8_000, preload, root => prepare(root, { port, password }));
  } finally {
    db.close();
    server.kill();
    await server.exited;
    await rm(storage, { recursive: true, force: true });
  }
}, 60_000);
