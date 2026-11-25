import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const oneBotCode = "001234567890";
const milkyCode = "12345678901";
const prefix = "/event/e20200928calculate/v1/furniture/";
const art = "https://upload-static.mihoyo.com/fixture-replica.png";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function preload(origin: string) {
  return `
const nativeFetch = globalThis.fetch;
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
globalThis.fetch = async (address, options) => {
  const url = new URL(address instanceof Request ? address.url : address);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return nativeFetch(address, options);
  if ((url.origin === "https://api-takumi.mihoyo.com" && url.pathname.startsWith(${JSON.stringify(prefix)})) ||
      url.href === ${JSON.stringify(art)}) {
    return nativeFetch(new URL(url.pathname + url.search, ${JSON.stringify(origin)}), options);
  }
  throw Error("隔离验收禁止外部请求：" + url.origin + url.pathname);
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
  for (const { qq, id, uid, region } of [{ qq: "42", id: 2, uid: "100000042", region: "cn_gf01" },
    { qq: "43", id: 1, uid: "500000043", region: "cn_qd01" }]) {
    await writeFile(join(root, "profiles", `${qq}${id === 1 ? "" : "-" + id}.yaml`), Bun.YAML.stringify({
      user: { qq }, profile: { id }, device: { bound: true, id: `device-${qq}`, fp: `fp-${qq}` }, account: {
        cookie: `account_id=${qq};cookie_token=replica-test-${qq};ltuid=${qq};ltoken=fixture`,
        stuid: qq, stoken: "fixture", ltuid: qq, ltoken: "fixture",
        game_roles: { gs: [{ uid, region, game_biz: "hk4e_cn" }] }, current_uid: { gs: uid },
      },
    }));
  }
}

function decodeImage(params: unknown) {
  const data = /base64:\/\/([A-Za-z0-9+/]+={0,2})/u.exec(JSON.stringify(params))?.[1];
  expect(data).toBeDefined();
  return Uint8Array.fromBase64(data!);
}

test("the original housing replica aliases reach the authenticated calculator through OneBot and Milky", async () => {
  const seen: string[] = [];
  let artwork = 0;
  const calculator = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture-replica.png") {
      expect(request.headers.has("Cookie")).toBe(false);
      expect(request.headers.has("Referer")).toBe(false);
      artwork++;
      return new Response(Uint8Array.fromBase64(png), { headers: { "Content-Type": "image/png" } });
    }
    const qq = /cookie_token=replica-test-(42|43)/u.exec(request.headers.get("Cookie") ?? "")?.[1];
    expect(qq).toBeDefined();
    expect(request.headers.get("x-rpc-device_id")).toBe(`device-${qq}`);
    const code = qq === "42" ? oneBotCode : milkyCode;
    const id = qq === "42" ? 100101 : 100202;
    if (url.pathname === `${prefix}blueprint`) {
      expect(request.method).toBe("GET");
      expect(url.searchParams.get("share_code")).toBe(code);
      expect(url.searchParams.get("region")).toBe(qq === "42" ? "cn_gf01" : "cn_qd01");
      seen.push(`${qq}:blueprint:${code}`);
      return Response.json({ retcode: 0, data: { share_code: code, list: [{ name: "松木长桌", id, num: "2", icon_url: art }] } });
    }
    expect(url.pathname).toBe(`${prefix}compute`);
    expect(request.method).toBe("POST");
    expect(await request.json()).toEqual({ list: [{ cnt: 2, id }] });
    seen.push(`${qq}:compute`);
    return Response.json({ retcode: 0, data: { list: [{ name: "松木", num: 8, icon: art }] } });
  } });
  try {
    await withDualGatewayFixture("genshin-blueprint", "disablePrivate: false\n", async ({ onebot, milky, sendOneBot, sendMilky }) => {
      sendOneBot(`#尘歌壶模数${oneBotCode} 档案2`, { message_type: "group", sub_type: "normal", group_id: 601 });
      const group = await onebot.next("send_msg");
      expect(group.params).toMatchObject({ group_id: 601, message: [{ type: "image" }] });
      const first = decodeImage(group.params);
      expect(await new Bun.Image(first).metadata()).toMatchObject({ width: 3848, height: 2132, format: "png" });
      group.respond({ message_id: 166 });

      await sendMilky(`#尘歌壶养成计算${milkyCode}`);
      const friend = await milky.next("send_private_message");
      expect(friend.params).toMatchObject({ user_id: 43, message: [{ type: "image" }] });
      const second = decodeImage(friend.params);
      expect(await new Bun.Image(second).metadata()).toMatchObject({ width: 3848, height: 2132, format: "png" });
      expect(second).not.toEqual(first);
      friend.respond({ message_seq: 167 });

      sendOneBot(`#尘歌壶模数${oneBotCode} 档案2`, { message_type: "group", sub_type: "normal", group_id: 601,
        message: [{ type: "text", data: { text: `#尘歌壶模数${oneBotCode} 档案2` } }, { type: "at", data: { qq: "43" } }] });
      const denied = await onebot.next("send_msg");
      expect(JSON.stringify(denied.params)).toContain("本人 QQ");
      denied.respond({ message_id: 168 });
      await sendMilky("#尘歌壶模数计算");
      const help = await milky.next("send_private_message");
      expect(JSON.stringify(help.params)).toContain("10 到 15 位摹本码");
      help.respond({ message_seq: 169 });
      expect(seen).toEqual([`42:blueprint:${oneBotCode}`, "42:compute", `43:blueprint:${milkyCode}`, "43:compute"]);
      expect(artwork).toBe(2);
    }, 8_000, preload(calculator.url.href), prepare);
  } finally { calculator.stop(true); }
}, 18_000);
