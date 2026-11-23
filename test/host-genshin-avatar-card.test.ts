import { expect, test } from "bun:test";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

async function prepare(root: string) {
  const source = join(import.meta.dir, "../plugins/genshin");
  const destination = join(root, "plugins", "genshin");
  await cp(source, destination, { recursive: true, filter: path => ![".git", "node_modules"].includes(basename(path)) });
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir");
  await symlink(join(import.meta.dir, "../packages"), join(root, "packages"), "dir");
  await mkdir(join(root, "profiles"), { recursive: true });
  for (const qq of [42, 43]) {
    const id = String(900_000_000 + qq);
    const uid = String(100_004_000 + qq);
    await writeFile(join(root, "profiles", `${qq}.yaml`), Bun.YAML.stringify({
      user: { qq: String(qq) }, profile: { id: 1 }, account: {
        stuid: id, ltuid: id, stoken: `token-${qq}`, ltoken: `login-${qq}`, updated_at: "2026-10-01",
        cookie: `account_id=${id}; cookie_token=fixture; ltuid=${id}; ltoken=login-${qq}`,
        game_roles: { gs: [{ uid, region: "cn_gf01", game_biz: "hk4e_cn" }] }, current_uid: { gs: uid },
      },
    }));
    const folder = join(root, "data", "genshin", "panels", String(qq));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${uid}.json`), JSON.stringify({
      uid, avatars: { 10000046: { id: 10000046, name: "胡桃", level: 90, elem: "pyro", _source: "enka" } },
    }));
  }
}

const preload = `
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
const fetchBase = globalThis.fetch;
globalThis.fetch = (value, options) => {
  const address = new URL(value instanceof Request ? value.url : value);
  if (address.hostname !== "127.0.0.1" && address.hostname !== "localhost") throw new Error("隔离验收禁止外部请求");
  return fetchBase(value, options);
};
`;

function assertImage(params: unknown) {
  const match = /base64:\/\/([A-Za-z0-9+/=]+)/u.exec(JSON.stringify(params));
  expect(match).not.toBeNull();
  expect(Buffer.from(match![1]!, "base64").subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

test("本机两协议收到角色卡和本人戳事件，未知回执不回退再发", async () => {
  await withDualGatewayFixture("genshin-avatar-fixture", "disablePrivate: false\n",
    async ({ ws, milky, onebot, sendOneBot, sendMilky, sendMilkyEvent }) => {
      sendOneBot("#胡桃卡片");
      const card = await onebot.next("send_msg");
      expect(card.params).toMatchObject({ user_id: 42 });
      assertImage(card.params);
      card.respond({ message_id: 101 });
      const poke = { post_type: "notice", notice_type: "notify", sub_type: "poke", user_id: 42, target_id: 99, self_id: 99 };
      ws.send(JSON.stringify(poke));
      const first = await onebot.next("send_msg");
      expect(first.params).toMatchObject({ user_id: 42 });
      assertImage(first.params);
      first.respond({}, "failed");
      ws.send(JSON.stringify(poke));
      ws.send(JSON.stringify({ ...poke, target_id: 44 }));

      await sendMilky("#老婆设置胡桃");
      const set = await milky.next("send_private_message");
      expect(JSON.stringify(set.params)).toContain("老婆已经设置");
      set.respond({ message_seq: 102 });
      expect((await sendMilkyEvent("friend_nudge", { user_id: 43, is_self_send: false, is_self_receive: true })).status).toBe(200);
      const second = await milky.next("send_private_message");
      expect(second.params).toMatchObject({ user_id: 43 });
      assertImage(second.params);
      second.respond({ message_seq: 103 });
      await Bun.sleep(100);
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    }, 8000, preload, prepare);
}, 20_000);

test("关闭原神戳卡后原有聊天角色卡仍可用", async () => {
  await withDualGatewayFixture("genshin-avatar-off-fixture", "disablePrivate: false\n",
    async ({ ws, milky, onebot, sendOneBot, sendMilkyEvent }) => {
      ws.send(JSON.stringify({ post_type: "notice", notice_type: "notify", sub_type: "poke", user_id: 42, target_id: 99, self_id: 99 }));
      await sendMilkyEvent("friend_nudge", { user_id: 43, is_self_send: false, is_self_receive: true });
      sendOneBot("#胡桃卡片");
      const card = await onebot.next("send_msg");
      expect(card.params).toMatchObject({ user_id: 42 });
      assertImage(card.params);
      card.respond({ message_id: 104 });
      await Bun.sleep(100);
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    }, 8000, preload + '\nBun.env.LOTUS_GENSHIN_AVATAR_POKE = "false";\n', prepare);
}, 20_000);
