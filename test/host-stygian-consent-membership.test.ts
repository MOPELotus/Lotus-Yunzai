import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const probe = `
  async function fallback(_message, context) {
    if (context.normalizedMessage !== "#核验幽境测试群" || context.message_type !== "private") return;
    if (!context.verifyOwnGroupMembership) return "没有主体核验能力";
    const ok = await context.verifyOwnGroupMembership(701, new AbortController().signal);
    return ok ? "成员已核实" : "成员无法核实";
  }
  export default { commands: {}, fallback };
`;

test("原神独享好友私聊主体核验能力，OneBot 和 Milky 按实返回机器人及发件人成员身份", async () => {
  await withDualGatewayFixture("stygian-members-fixture", 'master: ["99:42", "100:43"]\ndisablePrivate: false\n',
    async ({ onebot, milky, sendOneBot, sendMilky }) => {
      sendOneBot("#核验幽境测试群");
      const oneRequests = [await onebot.next("get_group_member_info"), await onebot.next("get_group_member_info")];
      expect(new Set(oneRequests.map(call => call.params.user_id))).toEqual(new Set([99, 42]));
      for (const request of oneRequests) {
        expect(request.params).toMatchObject({ group_id: 701, no_cache: true });
        request.respond({ ...request.params, role: "member" });
      }
      expect((await onebot.next("send_msg")).params).toMatchObject({ user_id: 42, message: "成员已核实" });

      await sendMilky("#核验幽境测试群");
      const milkyRequests = [await milky.next("get_group_member_info"), await milky.next("get_group_member_info")];
      expect(new Set(milkyRequests.map(call => call.params.user_id))).toEqual(new Set([100, 43]));
      for (const request of milkyRequests) {
        expect(request.params).toMatchObject({ group_id: 701, no_cache: true });
        request.respond({ member: { ...request.params, role: "member", group_id: request.params.user_id === 43 ? 702 : 701 } });
      }
      const response = await milky.next("send_private_message");
      expect(response.params).toMatchObject({ user_id: 43, message: [{ data: { text: "成员无法核实" } }] });
      response.respond({ message_seq: 701 });

      sendOneBot("#核验幽境测试群", { message_id: 44, raw_message: "伪造发送者", sender: { user_id: 63 } });
      expect((await onebot.next("send_msg")).params).toMatchObject({ user_id: 42, message: "没有主体核验能力" });
      sendOneBot("#其他模块核验测试群");
      expect((await onebot.next("send_msg")).params).toMatchObject({ user_id: 42, message: "没有主体核验能力" });
      expect(milky.calls).toEqual([]);
      expect(onebot.calls).toEqual([]);
    }, 4_000, undefined, async root => {
      const directory = join(root, "plugins", "genshin");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@lotus-yunzai/genshin",
        lotusYunzai: { entry: "./index.ts", games: ["genshin"] } }));
      await writeFile(join(directory, "index.ts"), probe);
      const otherModule = join(root, "plugins", "fixture");
      await mkdir(otherModule, { recursive: true });
      await writeFile(join(otherModule, "package.json"), JSON.stringify({ name: "@fixture/other", lotusYunzai: { entry: "./index.ts" } }));
      await writeFile(join(otherModule, "index.ts"), probe.replace("#核验幽境测试群", "#其他模块核验测试群"));
    });
}, 15_000);
