import { expect, test } from "bun:test";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("实际宿主经 OneBot 和 Milky 受信会话处理旧昵称设置、查阅和删除", async () => {
  await withDualGatewayFixture("legacy-nickname-fixture", 'master: ["99:42", "100:43"]\ndisablePrivate: false\n',
    async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
      const group = { message_type: "group", sub_type: "normal", group_id: 701, sender: { user_id: 42, role: "member" } };
      const oneText = async (text: string) => {
        const reply = await onebot.next("send_msg").catch(error => { throw new Error(text, { cause: error }); });
        expect(reply.params).toMatchObject({ group_id: 701 });
        expect(JSON.stringify(reply.params)).toContain(text);
        reply.respond({ message_id: 801 });
      };
      const milkyText = async (text: string) => {
        const reply = await milky.next("send_private_message");
        expect(reply.params).toMatchObject({ user_id: 43, message: [{ data: { text } }] });
        reply.respond({ message_seq: 802 });
      };
      sendOneBot("夹具#设置芙宁娜别名", group);
      await oneText("请发送芙宁娜别名，多个用空格隔开。");
      sendOneBot("测试剧团指挥 测试剧团副手", group);
      await oneText("设置别名成功：测试剧团指挥、测试剧团副手");
      sendOneBot("夹具#芙宁娜昵称", group);
      const list = await onebot.next("send_group_forward_msg");
      expect(list.params).toMatchObject({ group_id: 701 });
      expect(JSON.stringify(list.params)).toContain("测试剧团副手");
      expect(JSON.stringify(list.params)).toContain("归档小狐");
      list.respond({ message_id: 803 });
      sendOneBot("夹具#删除昵称归档小狐", group);
      await oneText("删除芙宁娜别名成功：归档小狐");

      expect((await sendMilky("*设置希儿昵称")).status).toBe(200);
      await milkyText("请发送希儿别名，多个用空格隔开。发送“取消”可退出。");
      expect((await sendMilky("测试星铁月台")).status).toBe(200);
      await milkyText("设置别名成功：测试星铁月台");
      expect((await sendMilky("*删除昵称测试星铁月台")).status).toBe(200);
      await milkyText("删除希儿别名成功：测试星铁月台");

      expect(await readFile(join(root, "config/character-aliases/alias_gs.cfg"), "utf8")).not.toContain("归档小狐");
      expect(await readFile(join(root, "backup/plugins/genshin/config/role.name.yaml"), "utf8")).toContain("归档小狐");
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    }, 3_000, undefined, async root => {
      await writeFile(join(root, "config/group.yaml"), "701: {onlyReplyAt: 1, botAlias: 夹具, groupCD: 0, singleCD: 0}\n");
      for (const file of ["plugins/genshin/panel/miao/character-alias.ts", "plugins/starrail/panel-theme/character-alias.ts",
        "plugins/starrail/challenge-character-names.json"]) {
        const target = join(root, file);
        await mkdir(dirname(target), { recursive: true });
        await cp(new URL(`../${file}`, import.meta.url), target);
      }
      const archive = join(root, "backup/plugins/genshin/config");
      await mkdir(archive, { recursive: true });
      await writeFile(join(archive, "role.name.yaml"), "芙宁娜: [归档小狐]\n");
    });
}, 12_000);
