import { expect, test } from "bun:test";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const url = "https://www.lotusshared.cn/yunzai/";

test("限制普通好友私聊时，三游统一帮助同义指令仍进入同一个网站入口", async () => {
  await withDualGatewayFixture("private-help-aliases", "disablePrivate: true\n", async ({ onebot, milky, sendOneBot, sendMilky }) => {
    for (const command of ["#帮助", "#原神帮助", "#说明", "菜单", "/help", "*命令", "%指令", "#自动签到帮助"]) {
      sendOneBot(command);
      const reply = await onebot.next("send_msg");
      expect(JSON.stringify(reply.params)).toContain(url);
      reply.respond({ message_id: 71 });
    }
    for (const command of ["#帮助", "#原神使用说明", "/帮助", "sr功能", "＃绝区零帮助", "%菜单"]) {
      await sendMilky(command);
      const reply = await milky.next("send_private_message");
      expect(JSON.stringify(reply.params)).toContain(url);
      reply.respond({ message_seq: 72 });
    }
    sendOneBot("#原神角色");
    const privateQuery = await onebot.next("send_msg");
    expect(JSON.stringify(privateQuery.params)).toContain("私聊功能已禁用");
    privateQuery.respond({ message_id: 73 });
    await sendMilky("*抽卡帮助");
    const featureHelp = await milky.next("send_private_message");
    expect(JSON.stringify(featureHelp.params)).toContain("私聊功能已禁用");
    featureHelp.respond({ message_seq: 74 });
  });
});
