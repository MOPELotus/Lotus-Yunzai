import { expect, test } from "bun:test";
import { cp, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const project = join(import.meta.dir, "..");
const gs = "123450001";
const sr = "123450002";
const secret = "synthetic-private-panel-field";
const friend = { sender_id: 42, peer_id: 42 };
const challenge = /LY-[a-f0-9]{16}/u;

async function prepare(root: string) {
  await symlink(join(project, "packages"), join(root, "packages"), "dir");
  for (const name of ["genshin", "starrail"]) {
    const source = join(project, "plugins", name);
    const target = join(root, "plugins", name);
    await cp(await realpath(source), target, { recursive: true, filter: path => ![".git", "node_modules"].includes(basename(path)) });
    const modules = join(target, "node_modules");
    await mkdir(join(modules, "@lotus-yunzai"), { recursive: true });
    for (const dependency of name === "genshin" ? ["skia-canvas", "@lotus-yunzai/atlas"] : ["skia-canvas"]) {
      await symlink(await realpath(join(source, "node_modules", dependency)), join(modules, dependency), "dir");
    }
  }
  await mkdir(join(root, "profiles"));
  await writeFile(join(root, "config/group.yaml"), "default: {groupCD: 0, singleCD: 0}\n");
  const panels = [
    { game: "gs", uid: gs, id: 10000046, row: { id: 10000046, name: "胡桃", elem: "pyro", level: 90, _source: "enka" } },
    { game: "sr", uid: sr, id: 1102, row: { id: "1102", level: 80, _source: "homo", trees: ["101"] } },
  ];
  for (const { game, uid, id, row } of panels) {
    const directory = join(root, "data", "PlayerData", game);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${uid}.json`), JSON.stringify({ uid, cookie: secret, avatars: {
      [id]: { ...row, stoken: secret, _time: Date.now() - 1000, talent: { a: 6, e: 8, q: 8, token: secret }, artis: {} },
    } }));
  }
}

function attachment(uri: unknown, uid: string) {
  expect(typeof uri).toBe("string");
  const encoded = String(uri);
  expect(encoded.startsWith("base64://")).toBe(true);
  const text = Buffer.from(encoded.slice("base64://".length), "base64").toString("utf8");
  expect(text).not.toContain(secret);
  expect(text).not.toMatch(challenge);
  const panel = JSON.parse(text);
  expect(String(panel.uid)).toBe(uid);
  return panel.avatars;
}

test("真实 OneBot 与 Milky 好友会话需确认送达，签名导出仅查询明确 UID 并隔离权限", async () => {
  const signatures = new Map<string, string>();
  const requests: { path: string; method: string; cookie: string | null; authorization: string | null; referer: string | null; body: string }[] = [];
  const publicProfiles = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    requests.push({ path: url.pathname + url.search, method: request.method, cookie: request.headers.get("Cookie"),
      authorization: request.headers.get("Authorization"), referer: request.headers.get("Referer"), body: await request.text() });
    if (url.pathname === `/api/uid/${gs}/`) return Response.json({ uid: Number(gs), playerInfo: { signature: signatures.get(gs) }, ttl: 5 });
    if (url.pathname === `/sr_info/${sr}`) return Response.json({ detailInfo: { uid: Number(sr), signature: signatures.get(sr) }, ttl: 5 });
    return new Response(null, { status: 404 });
  } });
  const preload = `
    Bun.env.LOTUS_PROFILE_DIR = "./profiles";
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "127.0.0.1") return nativeFetch(input, init);
      if (url.origin !== "https://enka.network" && url.origin !== "https://api.mihomo.me") {
        throw new Error("隔离宿主禁止连接其他外部地址。");
      }
      if (init.credentials !== "omit" || init.redirect !== "error" || init.referrerPolicy !== "no-referrer") {
        throw new Error("公开签名请求缺少隐私约束。");
      }
      const explicitHeaders = [...new Headers(init.headers).keys()].sort().join(",");
      if (explicitHeaders !== "accept,user-agent") throw new Error("公开签名请求附带意外的头字段。");
      const response = await nativeFetch(new URL(url.pathname + url.search, ${JSON.stringify(publicProfiles.url.origin)}), init);
      return new Response(response.body, { status: response.status, headers: response.headers });
    }, { preconnect: nativeFetch.preconnect });
  `;
  try {
    await withDualGatewayFixture("panel-signature-fixture", 'master: ["99:42", "100:42"]\ndisablePrivate: false\n', async gateway => {
      const { onebot, milky, root, sendOneBot, sendMilky } = gateway;
      let receipt = 1;
      async function onebotReply(expected: string, user = 42) {
        const reply = await onebot.next("send_msg");
        expect(reply.params).toMatchObject({ message_type: "private", user_id: user });
        expect(JSON.stringify(reply.params.message)).toContain(expected);
        reply.respond({ message_id: receipt++ });
      }
      async function milkyReply(expected: string) {
        const reply = await milky.next("send_private_message");
        expect(reply.params.user_id).toBe(42);
        expect(JSON.stringify(reply.params.message)).toContain(expected);
        reply.respond({ message_seq: receipt++ });
      }
      async function waitForReceipt(relativePath: string, code: string) {
        const file = join(root, "data/panel-signatures", relativePath);
        for (let attempt = 0; attempt < 100; attempt++) {
          const text = await readFile(file, "utf8");
          expect(text).not.toContain(code);
          if (JSON.parse(text).delivered === true) return;
          await Bun.sleep(10);
        }
        throw new Error("成功回执没有激活口令。");
      }

      sendOneBot(`#原神绑定UID ${gs}`, { message_type: "group", sub_type: "normal", group_id: 701 });
      const blocked = await onebot.next("send_msg");
      expect(blocked.params.group_id).toBe(701);
      expect(JSON.stringify(blocked.params.message)).toContain("好友私聊");
      expect(JSON.stringify(blocked.params.message)).not.toMatch(challenge);
      blocked.respond({ message_id: receipt++ });

      sendOneBot(`#绑定原神UID ${gs}`);
      const unconfirmed = await onebot.next("send_msg");
      expect(unconfirmed.params.user_id).toBe(42);
      const unconfirmedCode = JSON.stringify(unconfirmed.params.message).match(challenge)?.[0];
      expect(unconfirmedCode).toBeDefined();
      signatures.set(gs, unconfirmedCode!);
      unconfirmed.respond({});
      sendOneBot(`#原神验证UID ${gs}`);
      await onebotReply("没有对应的待验证口令");
      expect(requests).toEqual([]);

      sendOneBot(`#绑定原神UID${gs}`);
      const gsChallenge = await onebot.next("send_msg");
      expect(gsChallenge.params).toMatchObject({ user_id: 42, message_type: "private" });
      const gsCode = JSON.stringify(gsChallenge.params.message).match(challenge)?.[0];
      if (!gsCode) throw new Error("好友私聊未收到原神口令。");
      expect(gsCode).not.toBe(unconfirmedCode);
      signatures.set(gs, gsCode);
      gsChallenge.respond({ message_id: receipt++ });
      await waitForReceipt("onebot/gs/42/99.json", gsCode);

      await sendMilky(`#验证原神UID ${gs}`, friend);
      await milkyReply("没有对应的待验证口令");
      sendOneBot(`#验证原神UID ${gs}`, { user_id: 43 });
      await onebotReply("没有对应的待验证口令", 43);
      sendOneBot(`#验证原神UID ${sr}`);
      await onebotReply("没有对应的待验证口令");
      expect(requests).toEqual([]);

      sendOneBot(`#验证原神UID ${gs}`);
      await onebotReply(`已验证 UID ${gs}`);
      await sendMilky(`#原神导出面板 ${gs}`, friend);
      await milkyReply("请先签名验证");
      sendOneBot(`#原神导出面板 ${gs}`, { user_id: 43 });
      await onebotReply("请先签名验证", 43);
      sendOneBot(`#原神导出面板 ${sr}`);
      await onebotReply("请先签名验证");
      sendOneBot(`*导出面板 ${gs}`);
      await onebotReply("请先签名验证");

      sendOneBot(`#原神导出面板 UID${gs}`);
      const gsUpload = await onebot.next("upload_private_file");
      expect(gsUpload.params).toMatchObject({ user_id: 42, name: `${gs}.json` });
      const gsAvatars = attachment(gsUpload.params.file, gs);
      expect(Object.keys(gsAvatars)).toEqual(["10000046"]);
      expect(gsAvatars[10000046]).toMatchObject({ level: 90, talent: { a: 6 }, _source: "enka" });
      gsUpload.respond({ file_id: "isolated-genshin-panel" });
      await onebotReply(`已导出原神面板 ${gs}.json`);

      await sendMilky(`#绑定星铁UID ${sr}`, friend);
      const srUnconfirmed = await milky.next("send_private_message");
      expect(srUnconfirmed.params.user_id).toBe(42);
      const srUnconfirmedCode = JSON.stringify(srUnconfirmed.params.message).match(challenge)?.[0];
      if (!srUnconfirmedCode) throw new Error("好友私聊未发起星铁口令投递。");
      signatures.set(sr, srUnconfirmedCode);
      srUnconfirmed.respond({});
      await sendMilky(`#验证星铁UID ${sr}`, friend);
      await milkyReply("没有对应的待验证口令");
      expect(requests).toHaveLength(1);

      await sendMilky(`*绑定UID ${sr}`, friend);
      const srChallenge = await milky.next("send_private_message");
      expect(srChallenge.params.user_id).toBe(42);
      const srCode = JSON.stringify(srChallenge.params.message).match(challenge)?.[0];
      if (!srCode) throw new Error("好友私聊未收到星铁口令。");
      expect(srCode).not.toBe(srUnconfirmedCode);
      signatures.set(sr, srCode);
      srChallenge.respond({ message_seq: receipt++ });
      await waitForReceipt("milky/sr/42/100.json", srCode);
      await sendMilky(`*验证UID ${sr}`, friend);
      await milkyReply(`已验证 UID ${sr}`);
      await sendMilky(`*导出面板 ${sr}`, friend);
      const srUpload = await milky.next("upload_private_file");
      expect(srUpload.params).toMatchObject({ user_id: 42, file_name: `${sr}.json` });
      const srAvatars = attachment(srUpload.params.file_uri, sr);
      expect(Object.keys(srAvatars)).toEqual(["1102"]);
      expect(srAvatars[1102]).toMatchObject({ level: 80, talent: { a: 6 }, trees: ["101"], _source: "homo" });
      srUpload.respond({ file_id: "isolated-starrail-panel" });
      await milkyReply(`已导出 ${sr}.json`);

      sendOneBot(`#取消验证原神UID ${gs}`);
      await onebotReply("已撤回");
      sendOneBot(`#原神导出面板 ${gs}`);
      await onebotReply("请先签名验证");
      await sendMilky(`*取消验证UID ${sr}`, friend);
      await milkyReply("已撤回");
      await sendMilky(`#星铁导出面板 UID ${sr}`, friend);
      await milkyReply("请先签名验证");

      const onlyUid = { method: "GET", cookie: null, authorization: null, referer: null, body: "" };
      expect(requests).toEqual([{ ...onlyUid, path: `/api/uid/${gs}/?info` }, { ...onlyUid, path: `/sr_info/${sr}` }]);
      expect(await readdir(join(root, "profiles"))).toEqual([]);
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    }, 4_000, preload, prepare);
  } finally {
    publicProfiles.stop(true);
  }
}, 30_000);
