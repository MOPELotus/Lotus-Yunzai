import { expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const artworkUrl = "https://upload-bbs.miyoushe.com/profile-card-fixture.png";
const preload = `
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
Bun.env.LOTUS_PASSPORT_QR_RESOURCES = "./missing-theme";
const originalFetch = fetch;
globalThis.fetch = Object.assign(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1") return originalFetch(input, init);
  if (url.href !== ${JSON.stringify(artworkUrl)} || init.credentials !== "omit" ||
      new Headers(init.headers).has("Cookie")) throw new Error("非预期请求");
  await Bun.write("./artwork-entered", "1");
  const deadline = performance.now() + 1_500;
  while (!(await Bun.file("./artwork-continue").exists()) && performance.now() < deadline && !init.signal.aborted) await Bun.sleep(10);
  return new Response(null, { status: 404 });
}, { preconnect: originalFetch.preconnect });
`;

const profile = (qq: number, id: number, uid: string, title: string, artwork = false) => Bun.YAML.stringify({
  user: { qq, nickname: title }, profile: { id, name: "资料夹具" },
  account: { cookie: `account_id=${qq};cookie_token=fixture-cookie`, stoken: "fixture-stoken", stuid: String(qq),
    current_uid: { gs: uid }, game_roles: { gs: [{ uid, nickname: title, region: "cn_gf01", ...(artwork && { avatar_url: artworkUrl }) }] } },
});

test("本人资料卡在素材等待期间换档内容时不发送旧角色", async () => {
  await withDualGatewayFixture("own-profile-card-state", "disablePrivate: false\n", async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
    sendOneBot("#资料卡2", { message_type: "group", sub_type: "normal", group_id: 701 });
    const deadline = performance.now() + 1_500;
    while (!(await Bun.file(join(root, "artwork-entered")).exists()) && performance.now() < deadline) await Bun.sleep(10);
    expect(await Bun.file(join(root, "artwork-entered")).exists()).toBe(true);
    await writeFile(join(root, "profiles", "42-2.yaml"), profile(42, 2, "100000066", "新角色"));
    await writeFile(join(root, "artwork-continue"), "1");
    const stale = await onebot.next("send_msg");
    expect(stale.params).toMatchObject({ group_id: 701, message: "档案在查询期间已更新，请重新发送 #配置2。" });

    sendOneBot("#我的配置2");
    const current = await onebot.next("send_msg");
    expect(current.params).toMatchObject({ user_id: 42 });
    expect(current.params.message).toContain("新角色");
    expect(current.params.message).toContain("100000066（当前）");
    expect(current.params.message).not.toContain("100000055");
    expect(current.params.message).not.toContain("fixture-stoken");

    await sendMilky("#资料2");
    const missing = await milky.next("send_private_message");
    expect(JSON.stringify(missing.params)).toContain("请先扫码登录档案 2");
    expect(JSON.stringify(missing.params)).not.toContain("新角色");
  }, 3_000, preload, async root => {
    await symlink(join(import.meta.dir, "../packages"), join(root, "packages"), "dir");
    await mkdir(join(root, "profiles"));
    await writeFile(join(root, "profiles", "42-2.yaml"), profile(42, 2, "100000055", "旧角色", true));
  });
}, 10_000);
