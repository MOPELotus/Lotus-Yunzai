import { expect, test } from "bun:test";
import { cp, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const preload = `
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
const fetchBase = globalThis.fetch;
globalThis.fetch = Object.assign((input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw Error("禁止外部请求");
  return fetchBase(input, options);
}, { preconnect: fetchBase.preconnect });
`;

async function prepare(root: string) {
  for (const name of ["genshin", "starrail"]) {
    const source = join(import.meta.dir, "../plugins", name);
    const target = join(root, "plugins", name);
    await cp(source, target, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
    await symlink(join(source, "node_modules"), join(target, "node_modules"), "dir");
  }
  await symlink(join(import.meta.dir, "../packages"), join(root, "packages"), "dir");
}

test("紧连的已知原神角色展板经正常业务路由，保留星铁及仓库更新", async () => {
  await withDualGatewayFixture("named-showcase-normal", 'disablePrivate: false\nmaster: ["100:43"]\n',
    async ({ onebot, milky, sendOneBot, sendMilky }) => {
      const group = { message_type: "group", sub_type: "normal", group_id: 77 };
      for (const [input, shown] of [
        ["#更新胡桃面板", "档案 1 未绑定原神 UID"],
        ["#更新核桃详情 档案2", "档案 2 未绑定原神 UID"],
        ["*更新希儿面板", "请先登录 profile 1"],
        ["#更新不存在的角色面板", "暂无权限，只有主人才能操作"],
      ] as const) {
        sendOneBot(input, group);
        const reply = await onebot.next("send_msg");
        expect(JSON.stringify(reply.params)).toContain(shown);
        reply.respond({ message_id: 71 });
      }
      await sendMilky("#更新 胡桃面板");
      const repo = await milky.next("send_private_message");
      expect(JSON.stringify(repo.params)).toContain("当前未启用受管更新");
      repo.respond({ message_seq: 72 });
    }, 6500, preload, prepare);
}, 18_000);

test("关闭普通私聊时保留成员限制和主人的业务及仓库权限", async () => {
  await withDualGatewayFixture("named-showcase-closed", 'disablePrivate: true\nmaster: ["100:43"]\n',
    async ({ milky, sendMilky }) => {
      await sendMilky("#更新胡桃面板");
      const owner = await milky.next("send_private_message");
      expect(JSON.stringify(owner.params)).toContain("档案 1 未绑定原神 UID");
      owner.respond({ message_seq: 74 });
      await sendMilky("#更新胡桃面板", { sender_id: 44, peer_id: 44 });
      const blocked = await milky.next("send_private_message");
      expect(JSON.stringify(blocked.params)).toContain("私聊功能已禁用");
      blocked.respond({ message_seq: 75 });
      await sendMilky("#更新 胡桃面板");
      const repo = await milky.next("send_private_message");
      expect(JSON.stringify(repo.params)).toContain("当前未启用受管更新");
      repo.respond({ message_seq: 73 });
    }, 6500, preload, prepare);
}, 18_000);
