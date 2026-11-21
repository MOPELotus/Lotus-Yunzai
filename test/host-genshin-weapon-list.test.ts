import { expect, test } from "bun:test";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const fu = { id: 10000089, name: "芙宁娜", level: 90, rarity: 5,
  weapon: { name: "静水流涌之辉", rarity: 5, affix_level: 2, level: 90, type_name: "单手剑" } };
const ke = { id: 10000042, name: "刻晴", level: 80, rarity: 5,
  weapon: { name: "铁蜂刺", rarity: 4, affix_level: 5, level: 90, type_name: "单手剑" } };

const preload = `
const nativeFetch = globalThis.fetch;
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
Bun.env.LOTUS_SKIA_MODE = "gpu";
const fixture = { "123456789": [42, "cn_gf01"], "523456789": [43, "cn_qd01"] };
const seen = [];
globalThis.fetch = async (address, options) => {
  const url = new URL(address instanceof Request ? address.url : address);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return nativeFetch(address, options);
  if (url.href === "https://api-takumi-record.mihoyo.com/game_record/app/genshin/api/character/list") {
    const { role_id: uid, server } = JSON.parse(options.body);
    if (options.method !== "POST" || options.redirect !== "error" || fixture[uid]?.[1] !== server ||
        !new Headers(options.headers).get("Cookie")?.includes("cookie_token=weapon-test-" + fixture[uid][0])) {
      throw Error("武器列表读取了错误的档案");
    }
    seen.push(uid);
    await Bun.write("./requests.json", JSON.stringify(seen));
    return Response.json({ retcode: 0, data: { uid, server, list: ${JSON.stringify([fu, ke])} } });
  }
  throw Error("隔离验收禁止外部请求：" + url.origin + url.pathname);
};
`;

async function prepare(root: string) {
  const source = join(import.meta.dir, "../plugins/genshin");
  const destination = join(root, "plugins", "genshin");
  await cp(source, destination, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir");
  await symlink(join(import.meta.dir, "../packages"), join(root, "packages"), "dir");
  await mkdir(join(root, "profiles"), { recursive: true });
  for (const [qq, id, uid, region] of [[42, 2, "123456789", "cn_gf01"], [43, 1, "523456789", "cn_qd01"]]) {
    await writeFile(join(root, "profiles", `${qq}${id === 1 ? "" : "-" + id}.yaml`), Bun.YAML.stringify({
      user: { qq: String(qq) }, profile: { id }, account: {
        cookie: `account_id=${qq};cookie_token=weapon-test-${qq};ltuid=${qq};ltoken=fixture`,
        stuid: String(qq), stoken: "fixture", ltuid: String(qq), ltoken: "fixture",
        game_roles: { gs: [{ uid, region, game_biz: "hk4e_cn" }] }, current_uid: { gs: uid },
      },
    }));
  }
}

function imageBytes(params: unknown) {
  const data = /base64:\/\/([A-Za-z0-9+/]+={0,2})/u.exec(JSON.stringify(params))?.[1];
  expect(data).toBeDefined();
  return Uint8Array.fromBase64(data!);
}

test("the native host gives the original weapon aliases to the correct OneBot and Milky accounts", async () => {
  await withDualGatewayFixture("genshin-weapon-list", "disablePrivate: false\n", async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
    sendOneBot("#五星武器2", { message_type: "group", sub_type: "normal", group_id: 601 });
    const group = await onebot.next("send_msg");
    expect(group.params).toMatchObject({ group_id: 601, message: [{ type: "image" }] });
    const five = imageBytes(group.params);
    expect(await new Bun.Image(five).metadata()).toMatchObject({ format: "png" });
    group.respond({ message_id: 166 });

    await sendMilky("#4星武器");
    const friend = await milky.next("send_private_message");
    expect(friend.params).toMatchObject({ user_id: 43, message: [{ type: "image" }] });
    const four = imageBytes(friend.params);
    expect(await new Bun.Image(four).metadata()).toMatchObject({ format: "png" });
    expect(four).not.toEqual(five);
    friend.respond({ message_seq: 167 });

    sendOneBot("#武器2", { message_type: "group", sub_type: "normal", group_id: 601,
      message: [{ type: "text", data: { text: "#武器2" } }, { type: "at", data: { qq: "43" } }] });
    const denied = await onebot.next("send_msg");
    expect(JSON.stringify(denied.params)).toContain("本人 QQ");
    expect(await Bun.file(join(root, "requests.json")).json()).toEqual(["123456789", "523456789"]);
  }, 8_000, preload, prepare);
}, 18_000);
