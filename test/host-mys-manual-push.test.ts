import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { cp, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";
const preload = `
const native = globalThis.fetch;
globalThis.fetch = async (address, options) => {
  const url = new URL(address instanceof Request ? address.url : address);
  if (url.hostname === "127.0.0.1") return native(address, options);
  await Bun.write("./unexpected-network.txt", "denied");
  throw new Error("isolated owner command fixture");
};`;

test("当前宿主仅接受主人发送整轮公告与资讯命令，缺存储时无广播", async () => {
  await withDualGatewayFixture("mys-full-push-fixture", 'master: ["99:42", "100:43"]\n', async ({ root, sendOneBot, sendMilky, onebot, milky }) => {
    sendOneBot("#推送米游社全部", { user_id: 61 });
    const denied = await onebot.next("send_msg");
    expect(denied.params).toMatchObject({ user_id: 61, message: expect.stringContaining("仅机器人主人") });
    denied.respond({ message_id: 1001 });
    sendOneBot("#推送米游社全部");
    const onebotOwner = await onebot.next("send_msg");
    expect(onebotOwner.params).toMatchObject({ user_id: 42, message: "公告存储未连接。" });
    onebotOwner.respond({ message_id: 1002 });
    expect((await sendMilky("#推送米游社全部")).status).toBe(200);
    const milkyOwner = await milky.next("send_private_message");
    expect(milkyOwner.params).toMatchObject({ user_id: 43 });
    expect(JSON.stringify(milkyOwner.params)).toContain("公告存储未连接。");
    milkyOwner.respond({ message_seq: 1003 });
    sendOneBot("#崩三推送公告", { user_id: 61 });
    const deniedAlias = await onebot.next("send_msg");
    expect(deniedAlias.params).toMatchObject({ user_id: 61, message: expect.stringContaining("仅机器人主人") });
    deniedAlias.respond({ message_id: 1004 });
    sendOneBot("#崩二推送资讯");
    const academy = await onebot.next("send_msg");
    expect(academy.params).toMatchObject({ user_id: 42, message: "公告存储未连接。" });
    academy.respond({ message_id: 1005 });
    expect((await sendMilky("#未定推送公告")).status).toBe(200);
    const tears = await milky.next("send_private_message");
    expect(tears.params).toMatchObject({ user_id: 43 });
    expect(JSON.stringify(tears.params)).toContain("公告存储未连接。");
    tears.respond({ message_seq: 1006 });
    expect(onebot.calls).toEqual([]);
    expect(milky.calls).toEqual([]);
    expect(await Bun.file(join(root, "unexpected-network.txt")).exists()).toBe(false);
  }, 2400, preload, async root => {
    const target = join(root, "plugins", "notice");
    await cp(new URL("../plugins/notice", import.meta.url), target, { recursive: true, filter: name => ![".git", "node_modules"].includes(basename(name)) });
    await linkHostPackages(root);
    await symlink(join(import.meta.dir, "../plugins/notice/node_modules"), join(target, "node_modules"), "dir");
  });
});
