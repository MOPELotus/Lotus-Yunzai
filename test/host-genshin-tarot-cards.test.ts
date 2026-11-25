import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const imageEndpoint = "https://upload-static.mihoyo.com/fixture-tarot.png";
const tarotEndpoint = "https://api-takumi-record.mihoyo.com/game_record/app/genshin/api/role_combat";
const assets = Bun.env.LOTUS_TAROT_ARTIFACTS_DIR;
const fixtureIcon = { icon: imageEndpoint };
const album = (first: number, second: number) => ({ curr_num: 1, total_num: 2, list: [
  { name: "旅人", is_unlock: !!first, unlock_num: first, ...fixtureIcon },
  { name: "命运之轮", is_unlock: !!second, unlock_num: second, ...fixtureIcon },
] });

function preload() {
  return `
const nativeFetch = globalThis.fetch;
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
${assets ? 'Bun.env.LOTUS_SKIA_MODE = "gpu";' : ''}
const seen = [];
globalThis.fetch = async (address, options) => {
  const url = new URL(address instanceof Request ? address.url : address);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return nativeFetch(address, options);
  if (url.href === ${JSON.stringify(imageEndpoint)}) {
    if (new Headers(options.headers).has("Cookie")) throw Error("素材请求携带了账号凭据");
    return new Response(Uint8Array.fromBase64(${JSON.stringify(png)}), { headers: { "Content-Type": "image/png" } });
  }
  if (url.origin + url.pathname === ${JSON.stringify(tarotEndpoint)}) {
    const role = url.searchParams.get("role_id");
    const server = url.searchParams.get("server");
    const [qq, expected, tarot] = role === "100000042" ? [42, "cn_gf01", ${JSON.stringify(album(3, 0))}]
      : [43, "cn_qd01", ${JSON.stringify(album(0, 3))}];
    if (options.method !== "GET" || options.redirect !== "error" || server !== expected || url.searchParams.get("need_detail") !== "true" ||
        !new Headers(options.headers).get("Cookie")?.includes("cookie_token=tarot-test-" + qq)) throw Error("圣牌读错档案或参数");
    seen.push([qq, role, server]);
    await Bun.write("./tarot-requests.json", JSON.stringify(seen));
    return Response.json({ retcode: 0, data: { uid: role, server, tarot_card_state: tarot } });
  }
  throw Error("隔离夹具禁止外部请求：" + url.origin + url.pathname);
};
`;
}

async function prepare(root: string) {
  const source = join(import.meta.dir, "../plugins/genshin");
  const destination = join(root, "plugins", "genshin");
  await cp(source, destination, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir");
  await linkHostPackages(root);
  await mkdir(join(root, "profiles"), { recursive: true });
  for (const [qq, id, uid, region] of [[42, 2, "100000042", "cn_gf01"], [43, 1, "500000043", "cn_qd01"]] as const) {
    await writeFile(join(root, "profiles", `${qq}${id > 1 ? "-" + id : ""}.yaml`), Bun.YAML.stringify({
      user: { qq: String(qq) }, profile: { id }, account: {
        cookie: `account_id=${qq};cookie_token=tarot-test-${qq};ltuid=${qq};ltoken=fixture`,
        stuid: String(qq), stoken: "fixture", ltuid: String(qq), ltoken: "fixture",
        game_roles: { gs: [{ uid, region, game_biz: "hk4e_cn" }] }, current_uid: { gs: uid },
      },
    }));
  }
  // Use the same default path that the migrated runtime reads. Fresh CI has isolated assets.
  const theme = "data/genshin/miao-theme";
  for (const file of ["stat/imgs/bg1.png", "stat/imgs/footer.png", "common/font/NZBZ.woff", "common/font/HYWH-65W.woff", "common/font/tttgbnumber.woff"]) {
    const installed = Bun.file(join(import.meta.dir, "..", theme, file));
    const target = join(root, theme, file);
    await mkdir(dirname(target), { recursive: true });
    if (assets && await installed.exists()) await Bun.write(target, installed);
    else if (file.endsWith(".png")) await Bun.write(target, Uint8Array.fromBase64(png));
  }
}

test("OneBot 群聊通过正式模块展示圣牌并匹配交换，沿用当前档案和默认旧主题路径", async () => {
  await withDualGatewayFixture("genshin-tarot", "disablePrivate: false\n", async ({ root, onebot, sendOneBot }) => {
    const group = { message_type: "group", sub_type: "normal", group_id: 601 };
    async function receive(command: string, user_id: number, rosterReads: number, name: string, latestHeight: number) {
      sendOneBot(command, { ...group, user_id });
      for (let index = 0; index < rosterReads; index++) {
        const call = await onebot.next("get_group_member_list");
        expect(call.params).toMatchObject({ group_id: 601, no_cache: true });
        call.respond([42, 43, 99].map(user_id => ({ user_id, group_id: 601, nickname: `群成员${user_id}` })));
      }
      const reply = await onebot.next("send_msg");
      expect(reply.params).toMatchObject({ group_id: 601, message: [{ type: "image" }] });
      const image = /base64:\/\/([A-Za-z0-9+/]+={0,2})/u.exec(JSON.stringify(reply.params))?.[1];
      expect(image).toBeDefined();
      const bytes = Uint8Array.fromBase64(image!);
      expect(await new Bun.Image(bytes).metadata()).toMatchObject({ height: latestHeight * 4, width: 3880, format: "png" });
      if (assets) await Bun.write(join(assets, name + ".png"), bytes);
      reply.respond({ message_id: 801 + user_id });
    }
    await receive("#剧诗卡片收集2", 42, 2, "collection", 698);
    await receive("#月谕圣牌", 43, 2, "peer", 698);
    await receive("#月谕圣牌交换 档案2", 42, 3, "exchange", 854);
    expect(await Bun.file(join(root, "tarot-requests.json")).json()).toEqual([
      [42, "100000042", "cn_gf01"], [43, "500000043", "cn_qd01"], [42, "100000042", "cn_gf01"],
    ]);
    expect(await Bun.file(join(root, "data/genshin/tarot-cards/onebot/99/601/43.json")).exists()).toBe(true);
  }, 8_000, preload(), prepare);
}, 22_000);
