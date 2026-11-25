import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const image = "https://act-webstatic.mihoyo.com/fixture-growth.png";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const profiles = [
  { qq: "42", id: 2, uid: "100000042", region: "prod_gf_cn", owned: false },
  { qq: "43", id: 1, uid: "500000043", region: "prod_qd_cn", owned: true },
];

async function prepare(root: string) {
  const source = join(import.meta.dir, "../plugins/starrail");
  const destination = join(root, "plugins", "starrail");
  await cp(source, destination, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir");
  await linkHostPackages(root);
  await mkdir(join(root, "profiles"), { recursive: true });
  for (const { qq, id, uid, region } of profiles) {
    await writeFile(join(root, "profiles", `${qq}${id === 1 ? "" : "-" + id}.yaml`), Bun.YAML.stringify({
      user: { qq }, profile: { id }, device: { bound: true, id: `device-${qq}`, fp: `fp-${qq}` }, account: {
        cookie: `account_id=${qq};cookie_token=growth-test-${qq};ltuid=${qq};ltoken=fixture`,
        stuid: qq, stoken: "fixture", ltuid: qq, ltoken: "fixture",
        game_roles: { sr: [{ uid, region, game_biz: "hkrpg_cn" }] }, current_uid: { sr: uid },
      },
    }));
  }
}

function preload(origin: string) {
  return `
const nativeFetch = globalThis.fetch;
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
globalThis.fetch = async (address, options) => {
  const url = new URL(address instanceof Request ? address.url : address);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return nativeFetch(address, options);
  if ((url.origin === "https://api-takumi-record.mihoyo.com" && url.pathname === "/game_record/app/hkrpg/api/avatar/info") ||
      (url.origin === "https://api-takumi.mihoyo.com" && url.pathname.startsWith("/event/rpgcalc/")) ||
      url.href === ${JSON.stringify(image)}) {
    const local = await nativeFetch(new URL(url.pathname + url.search, ${JSON.stringify(origin)}), options);
    return new Response(local.body, { status: local.status, headers: local.headers });
  }
  throw Error("隔离验收禁止外出：" + url.origin + url.pathname);
};
`;
}

function decodeImage(params: unknown) {
  const data = /base64:\/\/([A-Za-z0-9+/]+={0,2})/u.exec(JSON.stringify(params))?.[1];
  expect(data).toBeDefined();
  return Uint8Array.fromBase64(data!);
}

test("旧星铁养成从真实宿主进 OneBot 群和 Milky 好友私聊，按本人档案选择 TabAll/TabOwned", async () => {
  const seen: string[] = [];
  const calc = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture-growth.png") {
      expect(request.headers.has("Cookie")).toBe(false);
      return new Response(Uint8Array.fromBase64(png), { headers: { "Content-Type": "image/png" } });
    }
    const profile = profiles.find(profile => request.headers.get("cookie")?.includes(`cookie_token=growth-test-${profile.qq}`));
    if (!profile) throw new Error("not a fixture account");
    expect(request.headers.get("x-rpc-device_fp")).toBe(`fp-${profile.qq}`);
    const ret = (data: object) => Response.json({ retcode: 0, data });
    if (url.pathname.endsWith("/avatar/info")) {
      expect(url.searchParams.get("role_id")).toBe(profile.uid);
      expect(url.searchParams.get("server")).toBe(profile.region);
      seen.push(`${profile.qq}:roster`);
      return ret({ avatar_list: profile.owned ? [
        { id: 1107, name: "克拉拉", level: 60, rarity: 5, icon: image,
          equip: { id: 23002, level: 65, rarity: 5, name: "无可取代的东西", icon: image } },
      ] : [] });
    }
    if (url.pathname.endsWith("/avatar/detail")) {
      const tab = url.searchParams.get("tab_from");
      expect(tab).toBe(profile.owned ? "TabOwned" : "TabAll");
      expect(url.searchParams.get("uid")).toBe(profile.uid);
      seen.push(`${profile.qq}:${tab}`);
      return ret({ is_login: profile.owned, avatar: { item_id: "1107", item_name: "克拉拉", rarity: "5", icon_url: image },
        skills: [1, 2, 3, 4].map(index => ({ point_id: 1107000 + index, anchor: `Point0${index}`,
          max_level: index === 1 ? 6 : 10, cur_level: profile.owned ? 2 : 1, item_url: image })) });
    }
    expect(url.pathname).toBe("/event/rpgcalc/compute");
    expect(request.method).toBe("POST");
    const body = await request.json() as Record<string, unknown>;
    expect(body).toMatchObject({ avatar: { item_id: 1107, cur_level: profile.owned ? 60 : 1, target_level: 75 },
      skill_list: [1, 2, 3, 4].map(index => ({ item_id: 1107000 + index, target_level: index === 1 ? 6 : 9 })) });
    if (profile.owned) expect(body.equipment).toMatchObject({ item_id: 23002, cur_level: 65, target_level: 80 });
    else expect(body.equipment).toBeUndefined();
    seen.push(`${profile.qq}:compute`);
    return ret({ avatar_consume: [{ item_name: "信用点", num: 4000, item_url: image }], skill_consume: [] });
  } });
  try {
    await withDualGatewayFixture("starrail-growth", "disablePrivate: false\n", async ({ onebot, milky, sendOneBot, sendMilky }) => {
      sendOneBot("*克拉拉养成75 80 6 9 9 9 档案2", { message_type: "group", sub_type: "normal", group_id: 601 });
      const group = await onebot.next("send_msg");
      expect(group.params).toMatchObject({ group_id: 601, message: [{ type: "image" }] });
      const first = decodeImage(group.params);
      expect(await new Bun.Image(first).metadata()).toMatchObject({ width: 2200, format: "png" });
      group.respond({ message_id: 166 });
      await sendMilky("#星铁克拉拉计算75，80，6 9 9 9");
      const friend = await milky.next("send_private_message");
      expect(friend.params).toMatchObject({ user_id: 43, message: [{ type: "image" }] });
      const second = decodeImage(friend.params);
      expect(await new Bun.Image(second).metadata()).toMatchObject({ width: 2200, format: "png" });
      expect(first).not.toEqual(second);
      friend.respond({ message_seq: 167 });
      expect(seen).toEqual(["42:roster", "42:TabAll", "42:compute", "43:roster", "43:TabOwned", "43:compute"]);
    }, 8_000, preload(calc.url.href), prepare);
  } finally {
    calc.stop(true);
  }
}, 30_000);
