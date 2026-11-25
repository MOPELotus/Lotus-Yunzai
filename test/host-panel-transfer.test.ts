import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { panelTransferPath } from "../lib/panel-transfer.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const openssl = Bun.which("openssl");
const project = fileURLToPath(new URL("../", import.meta.url));
const qq = "42";
const gs = "123450001";
const sr = "123450002";
const fromUser = { sender_id: Number(qq), peer_id: Number(qq) };
const settings = 'master: ["99:42", "100:42"]\ndisablePrivate: false\n';
const capability = /LPT1\.[A-Za-z0-9_.-]+/u;

const canary = `
  import { appendFileSync } from "node:fs";
  export default class TransferCanary extends plugin {
    constructor() {
      super({ name: "交接保护探针", event: "message", priority: 1,
        rule: [{ reg: "(LPT1\\\\.|独立面板测试)", fnc: "trap" }] });
    }
    trap(e) {
      appendFileSync("transfer-canary.log", "命中\\n");
      e.reply("正确送达探针");
      return true;
    }
  }
`;

async function installModules(root: string) {
  await linkHostPackages(root);
  for (const name of ["genshin", "starrail", "group"]) {
    const source = join(project, "plugins", name);
    const target = join(root, "plugins", name);
    await cp(await realpath(source), target, {
      recursive: true, filter: path => ![".git", "node_modules"].includes(basename(path)),
    });
    const installed = join(target, "node_modules");
    await mkdir(join(installed, "@lotus-yunzai"), { recursive: true });
    for (const dependency of name === "genshin" ? ["skia-canvas", "@lotus-yunzai/atlas"]
      : name === "group" ? ["skia-canvas", "yaml"] : ["skia-canvas"]) {
      const path = await realpath(join(source, "node_modules", dependency));
      await symlink(path, join(installed, dependency), "dir");
    }
  }
}

async function prepare(root: string, origin: URL, tls?: { readonly key: string; readonly cert: string }) {
  await installModules(root);
  await writeFile(join(root, "plugins", "transfer-canary.js"), canary);
  await writeFile(join(root, "config", "group-notice.yaml"), "default: { privateMessage: true, groupMessage: true }\n");
  await writeFile(join(root, "config", "bot.yaml"), Bun.YAML.stringify({
    cache_group_member: false,
    panelTransfer: tls ? { export: 1, import: 3, publicOrigin: origin.origin } : { export: 3, import: 2, peers: [origin.origin] },
  }));
  if (tls) await writeFile(join(root, "config", "server.yaml"), Bun.YAML.stringify({
    https: { ...tls, port: Number(origin.port), url: origin.origin },
  }));
  const profiles = join(root, "profiles");
  await mkdir(profiles);
  await writeFile(join(profiles, qq + "-2.yaml"), Bun.YAML.stringify({
    user: { qq }, profile: { id: 2 },
    account: {
      cookie: "account_id=900000002;cookie_token=fixture;ltuid=900000002;ltoken=fixture", stuid: "900000002", stoken: "fixture",
      current_uid: { gs, sr }, game_roles: {
        gs: [{ uid: gs, region: "cn_gf01", game_biz: "hk4e_cn" }],
        sr: [{ uid: sr, region: "prod_gf_cn", game_biz: "hkrpg_cn" }],
      },
    },
  }));
  if (!tls) return;
  const panels = [
    ["gs", gs, { id: 10000046, name: "胡桃", elem: "pyro", level: 90, _source: "enka" }],
    ["sr", sr, { id: 1102, name: "希儿", elem: "量子", level: 80, _source: "EnkaHSR" }],
  ] as const;
  for (const [game, uid, row] of panels) {
    const archive = join(root, "data", "PlayerData", game);
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, uid + ".json"), JSON.stringify({ uid, cookie: "forbidden-fixture-field", avatars: {
      [row.id]: { ...row, _time: Date.now() - 1000, cookie: "forbidden-fixture-field", talent: { a: 6, e: 8, q: 8 }, artis: {}, trees: [] },
    } }));
  }
}

test.skipIf(!openssl)("两隔离宿主用真实 HTTPS 交接原神和星铁面板并拦住交接码通知", async () => {
  const certDir = await mkdtemp(join(tmpdir(), "lotus-panel-transfer-https-"));
  try {
    const tls = { key: join(certDir, "fixture.key"), cert: join(certDir, "fixture.crt") };
    const generated = Bun.spawnSync([
      openssl!, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", tls.key, "-out", tls.cert,
    ], { stdout: "ignore", stderr: "pipe" });
    if (generated.exitCode !== 0) throw new Error("无法生成独立的 HTTPS 验收证书。");
    const ca = await readFile(tls.cert, "utf8");
    const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const origin = new URL(`https://127.0.0.1:${reservation.port}`);
    const preload = `
      Bun.env.LOTUS_PROFILE_DIR = "./profiles";
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = Object.assign((input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname !== "127.0.0.1") throw new Error("隔离夹具禁止对外联网。");
        return nativeFetch(input, url.origin === ${JSON.stringify(origin.origin)} ?
          { ...init, tls: { ca: ${JSON.stringify(ca)} } } : init);
      }, { preconnect: nativeFetch.preconnect });
    `;
    try {
      await withDualGatewayFixture("panel-transfer-source-fixture", settings, async source => {
        const response = await fetch(new URL(panelTransferPath, origin), { tls: { ca } });
        expect(response.status).toBe(405);
        const codes: string[] = [];
        for (const command of ["#导出面板数据 档案2", "*导出面板数据 档案2"]) {
          source.sendOneBot(command);
          const send = await source.onebot.next("send_msg");
          expect(send.params).toMatchObject({ message_type: "private", user_id: Number(qq) });
          const code = JSON.stringify(send.params.message).match(capability)?.[0];
          if (!code) throw new Error("来源宿主没有在本人私聊发送交接码。");
          codes.push(code);
          send.respond({ message_id: codes.length });
        }
        await withDualGatewayFixture("panel-transfer-destination-fixture", settings, async destination => {
          await destination.sendMilky("独立面板测试", fromUser);
          const canaryReply = await destination.milky.next("send_private_message");
          expect(JSON.stringify(canaryReply.params.message)).toContain("正确送达探针");
          canaryReply.respond({ message_seq: 991 });
          const observed = join(destination.root, "transfer-canary.log");
          expect(await readFile(observed, "utf8")).toBe("命中\n");

          const foreignFriend = { sender_id: 43, peer_id: 43 };
          await destination.sendMilky("无凭据的好友消息", foreignFriend);
          const privateNotice = await destination.milky.next("send_private_message");
          expect(privateNotice.params.user_id).toBe(Number(qq));
          expect(JSON.stringify(privateNotice.params.message)).toContain("无凭据的好友消息");
          privateNotice.respond({ message_seq: 997 });

          const foreignGroup = { peer_id: 860, message_scene: "group", sender_id: 43 };
          await destination.sendMilky("无凭据的群消息", foreignGroup);
          const description = await destination.milky.next("get_group_info");
          description.respond({ group: { group_id: 860, group_name: "合成群" } });
          const friends = await destination.milky.next("get_friend_list");
          friends.respond({ friends: [{ user_id: Number(qq) }, { user_id: 43 }] });
          const groupNotice = await destination.milky.next("send_private_message");
          expect(groupNotice.params.user_id).toBe(Number(qq));
          expect(JSON.stringify(groupNotice.params.message)).toContain("无凭据的群消息");
          groupNotice.respond({ message_seq: 998 });

          for (const code of codes) {
            await destination.sendMilky(code, foreignFriend);
            await destination.sendMilky(code, foreignGroup);
            await destination.sendMilky("#导入面板数据 " + code, foreignGroup);
            await destination.sendMilky(code, { ...foreignGroup, segments: [
              { type: "text", data: { text: code.slice(0, 3) } },
              { type: "text", data: { text: code.slice(3) } },
            ] });
          }
          for (const [index, [explicit, short]] of [["#原神", "#"], ["#星铁", "*"]].entries()) {
            const code = codes[index]!;
            await destination.sendMilky(`${explicit}导入面板数据 ${code} 档案2`, fromUser);
            const send = await destination.milky.next("send_private_message");
            expect(send.params.user_id).toBe(Number(qq));
            const reply = JSON.stringify(send.params.message);
            expect(reply.includes("已导入 1 名") && !capability.test(reply)).toBe(true);
            send.respond({ message_seq: 1000 + index });
            await destination.sendMilky(`${short}导入面板数据 ${code} 档案2`, fromUser);
            const duplicate = await destination.milky.next("send_private_message");
            expect(JSON.stringify(duplicate.params.message)).toContain("这份面板交接已完成");
            duplicate.respond({ message_seq: 1010 + index });
          }
          const saved = await Promise.all([
            readFile(join(destination.root, "data/genshin/panels", qq, gs + ".json"), "utf8"),
            readFile(join(destination.root, "data/starrail/panels", qq, sr + ".json"), "utf8"),
          ]);
          expect(saved[0]).toContain("胡桃");
          expect(saved[1]).toContain("希儿");
          expect(saved.join("").includes("forbidden-fixture-field")).toBe(false);
          expect(destination.milky.calls).toHaveLength(0);
          expect(await readFile(observed, "utf8")).toBe("命中\n");
        }, 7_000, preload, root => prepare(root, origin));
      }, 7_000, preload, async root => {
        await prepare(root, origin, tls);
        reservation.stop(true);
      });
    } finally {
      reservation.stop(true);
    }
  } finally {
    await rm(certDir, { recursive: true, force: true });
  }
}, 30_000);
