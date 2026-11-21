import { expect, test } from "bun:test";
import { cp, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const avatar = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const preload = `
const nativeFetch = globalThis.fetch;
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
Bun.env.LOTUS_SKIA_MODE = "gpu";
Bun.env.LOTUS_ZZZ_INVENTORY_THEME_DIR = "./no-old-art";
const roles = new Map([["123456789", 42], ["223456789", 43]]);
const tickets = ["RECHARGE_MONOCHROME", "POLYCHROME", "ENCRYPTED_MASTER_TAPE", "MASTER_TAPE", "BOOPON"];
let input = [];
globalThis.fetch = async (address, options) => {
  const url = new URL(address instanceof Request ? address.url : address);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return nativeFetch(address, options);
  if (url.hostname === "q1.qlogo.cn") {
    if (![...roles.values()].includes(Number(url.searchParams.get("nk")))) throw Error("头像请求不是当前操作者");
    return new Response(Uint8Array.fromBase64("${avatar}"), { headers: { "content-type": "image/png" } });
  }
  if (url.origin === "https://act-api-takumi.mihoyo.com" && url.pathname === "/event/nap_gacha_record/api/zzz/index") {
    const uid = url.searchParams.get("uid");
    if (new Headers(options.headers).get("Cookie") !== "cookie_token=fixture-zzz-" + roles.get(uid)) {
      throw Error("档案串到了另一会话");
    }
    input.push(uid);
    await Bun.write("./requests.json", JSON.stringify(input));
    return Response.json({ retcode: 0, data: {
      uid, region: "prod_gf_cn",
      cur_tickets: tickets.map((key, index) => ({ ticket_type: "GACHA_TICKET_TYPE_" + key, ticket_cnt: index + roles.get(uid) })),
    } });
  }
  throw Error("隔离验收禁止外部请求：" + url.origin + url.pathname);
};
`;

async function sources(root: string) {
  const source = join(import.meta.dir, "../plugins/zzz");
  const destination = join(root, "plugins", "zzz");
  await cp(source, destination, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir");
  const profiles = join(root, "profiles");
  await mkdir(profiles, { recursive: true });
  for (const [qq, id, uid] of [[42, 2, 123456789], [43, 1, 223456789]]) {
    await writeFile(join(profiles, `${qq}${id === 1 ? "" : "-" + id}.yaml`), `user: { qq: "${qq}" }
profile: { id: ${id} }
account:
  cookie: cookie_token=fixture-zzz-${qq}
  stoken: test-stoken
  stuid: "${qq}"
  game_roles: { zzz: [{ uid: "${uid}", region: prod_gf_cn, game_biz: nap_cn, nickname: "样本${qq}", level: 60 }] }
  current_uid: { zzz: "${uid}" }
`);
  }
}

function imageBytes(params: unknown) {
  const encoded = /base64:\/\/([A-Za-z0-9+/]+={0,2})/u.exec(JSON.stringify(params))?.[1];
  if (!encoded) throw Error(JSON.stringify(params));
  return Uint8Array.fromBase64(encoded);
}

test("正常宿主经 OneBot 群和 Milky 私聊直查不同档案库存，旧别名及防串档", async () => {
  await withDualGatewayFixture("zzz-inventory-fixture", "disablePrivate: false\n",
    async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
      sendOneBot("%母带2", { message_type: "group", sub_type: "normal", group_id: 600 });
      const group = await onebot.next("send_msg");
      expect(group.params).toMatchObject({ group_id: 600, message: [{ type: "image" }] });
      const first = imageBytes(group.params);
      expect(await new Bun.Image(first).metadata()).toMatchObject({ width: 2240, height: 1524, format: "png" });
      group.respond({ message_id: 156 });

      await sendMilky("#zzz存货");
      const friend = await milky.next("send_private_message");
      expect(friend.params).toMatchObject({ user_id: 43, message: [{ type: "image" }] });
      const second = imageBytes(friend.params);
      expect(await new Bun.Image(second).metadata()).toMatchObject({ width: 2240, height: 1524, format: "png" });
      expect(second).not.toEqual(first);
      friend.respond({ message_seq: 157 });

      sendOneBot("#绝区零存货2", { message_type: "group", sub_type: "normal", group_id: 600,
        message: [{ type: "text", data: { text: "#绝区零存货2" } }, { type: "at", data: { qq: "43" } }] });
      const denied = await onebot.next("send_msg");
      expect(JSON.stringify(denied.params)).toContain("只能查询自己");
      expect(await Bun.file(join(root, "requests.json")).json()).toEqual(["123456789", "223456789"]);
      expect(await readdir(join(root, "data", "zzzTuningStats")).catch(() => [])).toEqual([]);
    }, 8_000, preload, sources);
}, 18_000);
