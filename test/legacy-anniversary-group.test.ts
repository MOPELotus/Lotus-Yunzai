import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MessageFallbackContext } from "../lib/commands.ts";
import { legacyAnniversaryCommands } from "../lib/legacy-anniversary.ts";

test("群注册时间只读取本人档案，群会话撤销后不发布回执或缓存", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-anniversary-group-"));
  const directory = join(root, "profiles");
  const group = new AbortController();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let requests = 0;
  try {
    await mkdir(directory);
    await writeFile(join(directory, "42.yaml"), Bun.YAML.stringify({
      user: { qq: "42" }, profile: { id: 1 },
      account: { cookie: "ltoken=fixture-cookie", stoken: "fixture-stoken",
        game_roles: { gs: [{ uid: "123456789", region: "cn_gf01", game_biz: "hk4e_cn" }] } },
    }));
    const module = legacyAnniversaryCommands(pathToFileURL(root + "/"), directory, new AbortController().signal, {
      async request(source, _game, signal) {
        requests++;
        expect(source.qq).toBe("42");
        expect(source.role.uid).toBe("123456789");
        expect(signal.aborted).toBe(false);
        entered.resolve();
        await finish.promise;
        return { info_data: { game_uid: "123456789", region: "cn_gf01", game_biz: "hk4e_cn" },
          game_data: { data: { data: JSON.stringify({ "1-1-1": "2024-01-03" }) } }, query_time: Date.now() };
      },
    });
    const context: MessageFallbackContext = { normalizedMessage: "#刷新原神注册时间", raw_message: "#刷新原神注册时间",
      message_type: "group", sub_type: "normal", self_id: 99, user_id: 42, group_id: 701, message_id: 1,
      groupActivitySignal: group.signal, isMaster: false, isBotMaster: () => false, reply: () => true };
    for (const invalid of [{ isDelegated: true }, { sub_type: "anonymous" }, { sender: { user_id: 43 } },
      { groupActivitySignal: undefined }, { message_id: undefined }]) {
      expect(await module.fallback!(context.normalizedMessage, { ...context, ...invalid })).toBeUndefined();
    }
    expect(requests).toBe(0);
    const pending = module.fallback!(context.normalizedMessage, context);
    await entered.promise;
    group.abort();
    finish.resolve();
    expect(await pending).toBeUndefined();
    expect(requests).toBe(1);
    expect(await Bun.file(join(root, "data/anniversary/gs/42.json")).exists()).toBe(false);
  } finally {
    finish.resolve();
    await rm(root, { recursive: true, force: true });
  }
});
