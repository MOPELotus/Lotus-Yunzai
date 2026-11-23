import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("禁用私聊时两协议拦纯媒体及伪扩展名，仍放行主人和记录文件", async () => {
  const blocked = "私聊限制验收提示";
  const other = `master: ["99:840", "100:841"]\ndisablePrivate: true\ndisableMsg: ${blocked}\n`;
  await withDualGatewayFixture("private-media-access", other, async ({ onebot, milky, sendOneBot, sendMilky }) => {
    const image = { type: "image", data: { url: "https://fixture.example.invalid/image.png" } };
    const milkyImage = { type: "image", data: { temp_url: image.data.url } };
    const audio = { type: "record", data: { url: "https://fixture.example.invalid/audio" } };
    const milkyAudio = { type: "record", data: { temp_url: audio.data.url } };
    const oneFile = (name: string) => ({ type: "file", data: { file: "fixture", file_id: "fixture", name, file_size: 16 } });
    const milkyFile = (name: string) => ({ type: "file", data: { file_id: "fixture", file_name: name, file_size: 16 } });
    async function one(user: number, message: readonly object[], oldRaw: string | undefined, expected: string) {
      sendOneBot("", { user_id: user, message, raw_message: oldRaw });
      const reply = await onebot.next("send_msg");
      expect(reply.params.user_id).toBe(user);
      expect(JSON.stringify(reply.params.message)).toContain(expected);
      reply.respond({ message_id: user + 1000 });
    }
    async function mk(user: number, segments: readonly object[], expected: string) {
      expect((await sendMilky("", { sender_id: user, peer_id: user, segments })).status).toBe(200);
      const reply = await milky.next("send_private_message");
      expect(reply.params.user_id).toBe(user);
      expect(JSON.stringify(reply.params.message)).toContain(expected);
      reply.respond({ message_seq: user + 1000 });
    }

    await one(850, [image], "[CQ:image]", blocked);
    await one(851, [audio], "", blocked);
    await one(840, [image], undefined, "收到:image");
    await mk(856, [milkyImage], blocked);
    await mk(857, [milkyAudio], blocked);
    await mk(841, [milkyImage], "收到:image");
    await one(852, [oneFile("记录.json.exe")], "[文件：记录.json.exe]", blocked);
    await mk(853, [milkyFile("记录.xlsx.exe")], blocked);
    await one(854, [oneFile("记录.JSON")], undefined, "收到:file");
    await mk(855, [milkyFile("记录.xlsx")], "收到:file");
    expect(onebot.calls).toEqual([]);
    expect(milky.calls).toEqual([]);
  }, 5_000, undefined, async root => {
    await writeFile(join(root, "plugins", "private-media-access-fixture.js"), `
      export default class extends plugin {
        constructor() { super({ event: "message.private", rule: [{ fnc: "capture" }] }); }
        async capture(e) { return e.reply("收到:" + e.message[0]?.type); }
      }
    `);
  });
}, 18_000);
