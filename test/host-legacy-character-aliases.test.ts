import { expect, test } from "bun:test";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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

test("星铁独立旧配置按受信角色决定权限，添加使用现代存储和原会话", async () => {
  const archive = "backup/plugins/StarRail-plugin";
  const oldAliases = "希儿: [独立归档邮差]\n";
  await withDualGatewayFixture("independent-starrail-alias", 'master: ["99:42", "100:43"]\ndisablePrivate: false\n',
    async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
      const legacyMode = join(root, archive, "config/gachaHelp.yaml");
      const managed = join(root, "config/character-aliases/alias_sr.cfg");
      const group = { message_type: "group", sub_type: "normal", group_id: 701, user_id: 7, sender: { user_id: 7, role: "owner" } };
      let messageId = 900;
      async function oneText(text: string, target: { group_id: number } | { user_id: number } = { group_id: 701 }) {
        const reply = await onebot.next("send_msg").catch(error => { throw new Error(text, { cause: error }); });
        expect(reply.params).toMatchObject(target);
        expect(JSON.stringify(reply.params.message)).toContain(text);
        reply.respond({ message_id: messageId++ });
      }
      async function liveRole(role: "admin" | "member") {
        const info = { group_id: 701, member_count: 2 };
        (await onebot.next("get_group_info")).respond(info);
        const members = await onebot.next("get_group_member_list");
        expect(members.params).toMatchObject({ group_id: 701, no_cache: true });
        const joined = 1_690_000_000;
        members.respond([
          { group_id: 701, user_id: 99, role: "member", join_time: joined, last_sent_time: joined },
          { group_id: 701, user_id: 7, role, join_time: joined, last_sent_time: joined },
        ]);
        (await onebot.next("get_group_info")).respond(info);
      }

      sendOneBot("＊添加希儿昵称", group);
      await oneText("暂无权限");
      sendOneBot("#设置芙宁娜昵称", group);
      (await onebot.next("get_group_member_list")).respond([{group_id: 701, user_id: 99}, {group_id: 701, user_id: 7}]);
      await oneText("请发送芙宁娜别名");
      sendOneBot("取消", group);
      await oneText("已取消");

      await writeFile(legacyMode, "abbrSetAuth: 1\n");
      sendOneBot("#sr添加希儿昵称", group);
      await liveRole("member");
      await oneText("暂无权限");
      sendOneBot("*添加希儿别名", group);
      await liveRole("admin");
      await oneText("请发送希儿别名");
      sendOneBot("降权后别名", group);
      await liveRole("admin");
      await liveRole("member");
      await oneText("暂无权限");

      sendOneBot("*别名设置 希儿 査收员", group);
      await oneText("仅限本机器人主人");
      await writeFile(legacyMode, 'abbrSetAuth: "0"\n');
      sendOneBot("#星铁添加希儿昵称", { user_id: 7 });
      await oneText("暂无权限", { user_id: 7 });
      const groupMembers = [99, 7].map(user_id => ({ group_id: 701, user_id }));
      sendOneBot("*配置独立归档邮差昵称", group);
      (await onebot.next("get_group_member_list")).respond(groupMembers);
      await oneText("请发送希儿别名");
      sendOneBot("本群旧电报员", group);
      (await onebot.next("get_group_member_list")).respond(groupMembers);
      (await onebot.next("get_group_member_list")).respond(groupMembers);
      await oneText("设置别名成功：本群旧电报员");
      await writeFile(legacyMode, "abbrSetAuth: [\n");
      sendOneBot("*添加希儿昵称", group);
      await oneText("暂无权限");

      expect((await sendMilky("＊添加希儿昵称")).status).toBe(200);
      const prompt = await milky.next("send_private_message");
      expect(JSON.stringify(prompt.params)).toContain("请发送希儿别名");
      prompt.respond({ message_seq: 920 });
      expect((await sendMilky("旧别名新候选")).status).toBe(200);
      const assigned = await milky.next("send_private_message");
      expect(JSON.stringify(assigned.params)).toContain("设置别名成功：旧别名新候选");
      assigned.respond({ message_seq: 921 });

      sendOneBot("sr希儿昵称", group);
      const listed = await onebot.next("send_group_forward_msg");
      expect(JSON.stringify(listed.params)).toContain("独立归档邮差");
      expect(JSON.stringify(listed.params)).toContain("旧别名新候选");
      expect(JSON.stringify(listed.params)).not.toContain("降权后别名");
      listed.respond({ message_id: 922 });
      sendOneBot("*删除昵称独立归档邮差");
      await oneText("删除希儿别名成功", { user_id: 42 });
      expect(await readFile(join(root, archive, "config/alias.yaml"), "utf8")).toBe(oldAliases);
      expect(await readFile(managed, "utf8")).not.toContain("独立归档邮差");
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    }, 4_000, undefined, async root => {
      await writeFile(join(root, "config/group.yaml"), "default: {groupCD: 0, singleCD: 0}\n");
      const genshinPreset = "plugins/genshin/panel/miao/character-alias.ts";
      const genshinTarget = join(root, genshinPreset);
      await mkdir(dirname(genshinTarget), { recursive: true });
      await cp(new URL(`../${genshinPreset}`, import.meta.url), genshinTarget);
      const starRail = join(import.meta.dir, "../plugins/starrail");
      const starRailTarget = join(root, "plugins/starrail");
      await cp(starRail, starRailTarget, { recursive: true, dereference: true,
        filter: path => ![".git", "node_modules", "test"].includes(basename(path)) });
      await symlink(join(starRail, "node_modules"), join(starRailTarget, "node_modules"), "dir");
      await symlink(join(import.meta.dir, "../packages"), join(root, "packages"), "dir");
      for (const folder of [archive + "/config", archive + "/defSet", "backup/plugins/genshin/config"]) {
        await mkdir(join(root, folder), { recursive: true });
      }
      await writeFile(join(root, archive, "config/alias.yaml"), oldAliases);
      await writeFile(join(root, archive, "config/gachaHelp.yaml"), "renderScale: 100\n");
      await writeFile(join(root, archive, "defSet/gachaHelp.yaml"), "abbrSetAuth: 2\n");
      await writeFile(join(root, "backup/plugins/genshin/config/mys.set.yaml"), "abbrSetAuth: 0\n");
    });
}, 18_000);
