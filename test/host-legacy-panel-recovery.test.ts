import { expect, test } from "bun:test";
import { cp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const project = join(import.meta.dir, "..");
const gs = "123450001";
const sr = "123450002";
const friend = { sender_id: 42, peer_id: 42 };

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
  const common = { user: { qq: "42" } };
  await writeFile(join(root, "profiles/42-2.yaml"), Bun.YAML.stringify({ ...common, profile: { id: 2 },
    account: { cookie: "account_id=12;cookie_token=isolated;ltuid=12;ltoken=isolated", stuid: "12", stoken: "isolated",
      current_uid: { gs }, game_roles: { gs: [{ uid: gs, region: "cn_gf01", game_biz: "hk4e_cn" }] },
    },
  }));
  await writeFile(join(root, "profiles/42-3.yaml"), Bun.YAML.stringify({ ...common, profile: { id: 3 },
    account: { current_uid: { sr }, game_roles: { sr: [{ uid: sr, region: "prod_gf_cn", game_biz: "hkrpg_cn" }] } },
  }));
  const verified = join(root, "data/panel-signatures/milky/sr/42");
  await mkdir(verified, { recursive: true });
  await writeFile(join(verified, "100.json"), JSON.stringify({
    version: 1, adapter: "milky", game: "sr", bot: 100, user: 42, uid: sr,
    state: "verified", generation: "a".repeat(64), expires: Date.now() + 10 * 60_000,
  }));
}

test("正式原铁首次更新须在好友私聊确认后才读旧私人面板", async () => {
  const accesses: { path: string; method: string; cookie: string | null; authorization: string | null; body: unknown }[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.text();
    accesses.push({ path, method: request.method, cookie: request.headers.get("Cookie"),
      authorization: request.headers.get("Authorization"), body: body && JSON.parse(body) });
    if (path === "/panel/data") {
      const { type, uid } = JSON.parse(body);
      const avatar = type === "gs" ? { id: 10000046, name: "胡桃", elem: "pyro", level: 90, _source: "enka", artis: {} }
        : { id: 1102, name: "希儿", level: 80, _source: "EnkaHSR", artis: {}, trees: [] };
      return Response.json({ retcode: 100, data: { playerData: { uid, avatars: { [avatar.id]: avatar } } } });
    }
    return new Response(null, { status: 503 });
  } });
  const preload = `
    Bun.env.LOTUS_PROFILE_DIR = "./profiles";
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "127.0.0.1") return nativeFetch(input, init);
      if (url.hostname !== "ark.ivny.cn" && !url.hostname.endsWith(".mihoyo.com")) throw new Error("隔离夹具禁止此网络请求。");
      const response = await nativeFetch(new URL(url.pathname + url.search, ${JSON.stringify(upstream.url.origin)}), init);
      return new Response(response.body, { status: response.status, headers: response.headers });
    }, { preconnect: nativeFetch.preconnect });
  `;
  try {
    await withDualGatewayFixture("legacy-panels-fixture", 'master: ["99:42", "100:42"]\ndisablePrivate: false\n', async gateway => {
      const { onebot, milky, root, sendOneBot, sendMilky } = gateway;
      let receipt = 600;
      async function replyFromOneBot() {
        const message = await onebot.next("send_msg");
        const data = JSON.stringify(message.params.message);
        message.respond({ message_id: ++receipt });
        return data;
      }
      async function replyFromMilky() {
        const message = await milky.next("send_private_message");
        expect(message.params.user_id).toBe(42);
        const data = JSON.stringify(message.params.message);
        message.respond({ message_seq: ++receipt });
        return data;
      }
      const requests = () => accesses.filter(call => call.path === "/panel/data");
      sendOneBot("#更新面板2");
      expect(await replyFromOneBot()).not.toContain("ark.ivny.cn");
      expect(requests()).toHaveLength(0);

      await writeFile(join(root, "config/global.yaml"), "panel_legacy_recovery: true\n");
      sendOneBot("#原神面板更新2");
      const gsPrompt = await replyFromOneBot();
      expect(gsPrompt).toContain("你的 QQ");
      expect(gsPrompt).toContain(`#确认恢复旧面板 ${gs} 档案2`);
      expect(accesses.some(call => call.path !== "/panel/data")).toBe(true);
      expect(requests()).toHaveLength(0);
      await sendMilky(`#确认恢复旧面板 ${gs} 档案2`, friend);
      expect(await replyFromMilky()).toContain("没有待确认");
      const group = { message_type: "group", sub_type: "normal", group_id: 701 };
      sendOneBot(`#确认恢复旧面板 ${gs} 档案2`, group);
      expect(await replyFromOneBot()).toContain("好友私聊");
      expect(requests()).toHaveLength(0);
      sendOneBot(`#原神确认恢复旧面板 ${gs} 档案2`);
      expect(await replyFromOneBot()).toContain("已恢复 1 名原神角色");
      expect(JSON.parse(await readFile(join(root, "data/genshin/panels/42", gs + ".json"), "utf8")).avatars)
        .toMatchObject({ "10000046": { name: "胡桃" } });

      await sendMilky("*更新面板3", friend);
      expect(await replyFromMilky()).toContain(`*确认恢复旧面板 ${sr} 档案3`);
      expect(requests()).toHaveLength(1);
      await sendMilky(`*确认恢复旧面板 ${sr} 档案3`, friend);
      expect(await replyFromMilky()).toContain("已恢复 1 名星铁角色");
      expect(JSON.parse(await readFile(join(root, "data/starrail/panels/42", sr + ".json"), "utf8")))
        .toMatchObject({ uid: sr, source: "legacy", avatars: [{ id: "1102", name: "希儿" }] });

      sendOneBot("#获取游戏角色详情2");
      expect(await replyFromOneBot()).not.toContain("ark.ivny.cn");
      expect(requests()).toEqual(([["gs", gs], ["sr", sr]] as const).map(([type, uid]) => ({
        path: "/panel/data", method: "POST", cookie: null, authorization: null, body: { uid, qq: 42, type, version: "2.1.0" },
      })));
      expect(accesses.some(call => call.path === "/panel/refresh")).toBe(false);
    }, 7000, preload, prepare);
  } finally {
    upstream.stop(true);
  }
}, 30_000);
