import { expect, test } from "bun:test";
import { cp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const authUrl = "https://api-takumi.mihoyo.com/binding/api/genAuthKey";
const gachaUrl = "https://public-operation-common.mihoyo.com/common/gacha_record/api/getGachaLog";
const uid = "100000003";
const testKey = "fixture-issued-key";

const preload = `
const network = globalThis.fetch;
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1") return network(input, init);
  if (url.href !== ${JSON.stringify(authUrl)}) throw Error("isolation");
  const hold = await Bun.file("./hold-auth").exists();
  const selected = JSON.parse(String(init.body)).game_uid;
  await Bun.write("./auth-started", String(selected));
  if (hold) {
    if (!init.signal.aborted) await new Promise(resolve => init.signal.addEventListener("abort", resolve, { once: true }));
    await Bun.write("./auth-aborted", "disconnected");
    throw Error("revoked workflow");
  }
  return Response.json({ retcode: 0, data: { game_uid: selected, authkey: ${JSON.stringify(testKey)} } });
};
`;

async function prepare(root: string) {
  const source = await realpath(join(import.meta.dir, "../plugins/zzz"));
  const destination = join(root, "plugins", "zzz");
  await cp(source, destination, { recursive: true, filter: file => ![".git", "node_modules", "resources"].includes(basename(file)) });
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir");
  await symlink(join(import.meta.dir, "../packages"), join(root, "packages"), "dir");
  await mkdir(join(root, "profiles"), { recursive: true });
  for (const qq of [42, 43]) {
    await writeFile(join(root, "profiles", `${qq}.yaml`), Bun.YAML.stringify({
      user: { qq: String(qq) }, profile: { id: 1 }, account: {
        stuid: String(qq), stoken: "fixture-login",
        stoken_cookie: `stuid=${qq};stoken=fixture-login`,
        cookie: `account_id=${qq};cookie_token=fixture-cookie`,
        game_roles: { zzz: [{ uid, region: "prod_gf_cn", game_biz: "nap_cn" }] },
        current_uid: { zzz: uid },
      }, device: { id: `fixture-device-${qq}`, fp: "0123456789abc", android_version: "14" },
    }));
  }
}

async function waitFor(path: string) {
  for (let i = 0; i < 100; i++) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(20);
  }
  throw Error("未观察到合成授权状态");
}

test("绝区零官方抽卡链接仅由当前好友网关申请和返回，连接断开取消在途授权", async () => {
  await withDualGatewayFixture("zzz-auth-fixture", "disablePrivate: false\n", async ({
    root, ws, onebot, milky, sendOneBot, sendMilky,
  }) => {
    const started = join(root, "auth-started");
    sendOneBot("%获取抽卡链接", { sub_type: "group" });
    const rejected = await onebot.next("send_msg");
    expect(rejected.params).toMatchObject({ user_id: 42, message: expect.stringContaining("好友私聊") });
    rejected.respond({ message_id: 1 });
    expect(await Bun.file(started).exists()).toBe(false);

    sendOneBot("#绝区零获取抽卡链接");
    const native = await onebot.next("send_msg");
    expect(native.params.user_id).toBe(42);
    const link = new URL(String(native.params.message));
    expect(link.origin + link.pathname).toBe(gachaUrl);
    expect(link.searchParams.get("authkey")).toBe(testKey);
    native.respond({ message_id: 2 });
    expect(await Bun.file(started).text()).toBe(uid);

    await sendMilky("#绝区零获取抽卡链接");
    const webhook = await milky.next("send_private_message");
    expect(webhook.params.user_id).toBe(43);
    expect(JSON.stringify(webhook.params)).toContain(testKey);
    webhook.respond({ message_seq: 3 });

    await Bun.file(started).delete();
    await Bun.write(join(root, "hold-auth"), "yes");
    sendOneBot("%获取抽卡链接1");
    await waitFor(started);
    ws.close();
    await waitFor(join(root, "auth-aborted"));
    expect(onebot.calls).toHaveLength(0);
  }, 3_500, preload, prepare);
}, 14_000);
