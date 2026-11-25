import { linkHostPackages } from "./host-fixture.ts";
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
  await linkHostPackages(root);
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
  for (const [qq, id, uid, accountId] of [["42", 1, gs, "4242"], ["42", 2, "123450003", "4444"], ["43", 1, "123450099", "4343"]] as const) {
    await writeFile(join(root, "profiles", `${qq}${id === 1 ? "" : `-${id}`}.yaml`), Bun.YAML.stringify({
      user: { qq }, profile: { id }, device: { id: `fixture-bound-${accountId}`, fp: "0123456789abc", bound: true }, account: { stuid: accountId, stoken: "fixture-login-token", cookie: `ltuid=${accountId}; cookie_token=fixture-login-cookie`,
        current_uid: { gs: uid, sr }, game_roles: {
          gs: [{ uid, region: "cn_gf01", game_biz: "hk4e_cn" }],
          sr: [{ uid: sr, region: "prod_gf_cn", game_biz: "hkrpg_cn" }],
        },
      },
    }));
  }
  const proofs = join(root, "data/panel-signatures/onebot/gs/43");
  await mkdir(proofs, { recursive: true });
  await writeFile(join(proofs, "99.json"), JSON.stringify({ version: 1, game: "gs", bot: 99, user: 43, adapter: "onebot",
    state: "verified", uid: gs, generation: "a".repeat(64), expires: Date.now() + 1_800_000 }));
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

test("双协议面板导出只认当前登录档案角色，旧 UID 口令与公开引用不能授予权限", async () => {
  const preload = `
    Bun.env.LOTUS_PROFILE_DIR = "./profiles";
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "127.0.0.1") return nativeFetch(input, init);
      await Bun.write("./unexpected-external-request.txt", url.origin + url.pathname);
      throw new Error("档案归属导出不得向公开签名或其他外部接口发请求。");
    }, { preconnect: nativeFetch.preconnect });
  `;
  await withDualGatewayFixture("panel-profile-owner-fixture", 'master: ["99:42", "100:42"]\ndisablePrivate: false\n', async gateway => {
    const { onebot, milky, root, sendOneBot, sendMilky } = gateway;
    let receipt = 1;
    const oldProof = join(root, "data/panel-signatures/onebot/gs/43/99.json");
    const proofBytes = await readFile(oldProof);
    async function onebotReply(expected: string, user = 42, group = false) {
      const reply = await onebot.next("send_msg").catch(error => { throw new Error(`未收到回执：${expected}`, { cause: error }); });
      expect(reply.params).toMatchObject(group ? { message_type: "group", group_id: 701 } : { message_type: "private", user_id: user });
      expect(JSON.stringify(reply.params.message)).toContain(expected);
      expect(JSON.stringify(reply.params.message)).not.toMatch(challenge);
      reply.respond({ message_id: receipt++ });
    }
    async function milkyReply(expected: string) {
      const reply = await milky.next("send_private_message");
      expect(reply.params.user_id).toBe(42);
      expect(JSON.stringify(reply.params.message)).toContain(expected);
      expect(JSON.stringify(reply.params.message)).not.toMatch(challenge);
      reply.respond({ message_seq: receipt++ });
    }

    sendOneBot(`#原神绑定UID ${gs}`, { message_type: "group", sub_type: "normal", group_id: 701 });
    await onebotReply("UID 独立绑定已停用", 42, true);
    await sendMilky(`*验证UID ${sr}`, friend);
    await milkyReply("UID 独立绑定已停用");
    sendOneBot(`#取消验证原神UID ${gs}`, { user_id: 43 });
    await onebotReply("UID 独立绑定已停用", 43);
    expect(await readFile(oldProof)).toEqual(proofBytes);

    sendOneBot(`#原神导出面板 ${gs}`, { message_type: "group", sub_type: "normal", group_id: 701 });
    await onebotReply("好友私聊", 42, true);
    expect(onebot.calls.some(call => call.action === "upload_group_file")).toBe(false);
    // The same command in a separate conversation must not be swallowed by duplicate protection.
    sendOneBot(`#原神导出面板 ${gs}`);
    const gsUpload = await onebot.next("upload_private_file");
    expect(gsUpload.params).toMatchObject({ user_id: 42, name: `${gs}.json` });
    const gsAvatars = attachment(gsUpload.params.file, gs);
    expect(Object.keys(gsAvatars)).toEqual(["10000046"]);
    expect(gsAvatars[10000046]).toMatchObject({ level: 90, talent: { a: 6 }, _source: "enka" });
    gsUpload.respond({ file_id: "isolated-genshin-panel" });
    await onebotReply(`已导出原神面板 ${gs}.json`);

    // A verified proof left by the retired system cannot authorize someone else's role.
    sendOneBot(`#原神导出面板 ${gs}`, { user_id: 43 });
    await onebotReply("当前档案", 43);
    expect(await readFile(oldProof)).toEqual(proofBytes);
    sendOneBot(`#原神导出面板 ${sr}`);
    await onebotReply("当前档案");
    sendOneBot(`*导出面板 ${gs}`);
    await onebotReply("当前档案");

    await sendMilky(`*导出面板 ${sr}`, friend);
    const srUpload = await milky.next("upload_private_file");
    expect(srUpload.params).toMatchObject({ user_id: 42, file_name: `${sr}.json` });
    const srAvatars = attachment(srUpload.params.file_uri, sr);
    expect(Object.keys(srAvatars)).toEqual(["1102"]);
    expect(srAvatars[1102]).toMatchObject({ level: 80, talent: { a: 6 }, trees: ["101"], _source: "homo" });
    srUpload.respond({ file_id: "isolated-starrail-panel" });
    await milkyReply(`已导出 ${sr}.json`);

    sendOneBot("#切换档案2");
    await onebotReply("档案");
    sendOneBot(`#原神导出面板 UID ${gs}`);
    await onebotReply("当前档案");
    expect(await Bun.file(join(root, "unexpected-external-request.txt")).exists() ? await Bun.file(join(root, "unexpected-external-request.txt")).text() : "").toBe("");
    expect(await readFile(oldProof)).toEqual(proofBytes);
    expect(onebot.calls).toEqual([]);
    expect(milky.calls).toEqual([]);
  }, 4_000, preload, prepare);
}, 20_000);
