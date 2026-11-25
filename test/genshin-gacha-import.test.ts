import { expect, test } from "bun:test";
import { ProfileError } from "@lotus-yunzai/account";
import { mergeGenshinGachaHistory } from "../plugins/genshin/gacha-history.ts";
import { createGenshinGachaImport, gachaImportCommand } from "../plugins/genshin/gacha-import.ts";

test("UIGF 导入只接受发起请求的可信账号和原会话，并在换角时保持历史", async () => {
  let uid = "100000002";
  let calls = 0;
  let reads = 0;
  let profileError: "missing" | "role-missing" | undefined;
  const importFile = createGenshinGachaImport(
    {
      async savedRole() {
        if (profileError) throw new ProfileError(profileError, "测试档案不可用");
        return { uid, nickname: "", region: "cn_gf01", gameBiz: "hk4e_cn", chosen: true };
      },
    },
    {
      async merge(identity, snapshot, verifyProfile) {
        await verifyProfile();
        calls++;
        return mergeGenshinGachaHistory({}, snapshot, identity);
      },
    },
    new AbortController().signal,
  );
  const context = { self_id: 99, user_id: 42, group_id: 77, message_type: "group", canReadAttachments: true, reply() {} };
  const start = gachaImportCommand.exec("#强制导入记录2");
  expect(start).not.toBeNull();
  expect(await importFile({ ...context, canReadAttachments: false }, start)).toMatch(/暂不支持/);
  profileError = "missing";
  expect(await importFile(context, start)).toBe("请先登录 profile 2。");
  profileError = "role-missing";
  expect(await importFile(context, start)).toBe("profile 2 没有同步原神 UID。");
  profileError = undefined;
  const attachment = {
    name: "pulls.json",
    async read() {
      reads++;
      return Buffer.from(JSON.stringify({ info: { uid, uigf_version: "v2.3" }, list: [
        { id: "1720000000000000001", gacha_type: "301", name: "砂糖", rank_type: "4", item_type: "角色", time: "2023-11-22 12:22:00" },
      ] }));
    },
  };
  expect(await importFile({ ...context, attachment }, null)).toBeUndefined();
  expect(await importFile(context, start)).toMatch(/发送 JSON 文件/);
  for (const unrelated of [{ user_id: 43 }, { adapter: "milky" }, { group_id: 78 }, { self_id: 97 }]) {
    expect(await importFile({ ...context, ...unrelated, attachment }, null)).toBeUndefined();
  }
  expect(reads).toBe(0);
  uid = "100000003";
  expect(await importFile({ ...context, attachment }, null)).toMatch(/角色已变化/);
  expect(reads).toBe(0);
  expect(calls).toBe(0);
  expect(await importFile(context, start)).toMatch(/发送 JSON 文件/);
  expect(await importFile({ ...context, attachment }, null)).toMatch(/UID 100000003.*\n角色记录：读取 1 条，新增 1 条/);
  expect(await importFile({ ...context, attachment }, null)).toBeUndefined();
  expect(reads).toBe(1);
  expect(calls).toBe(1);
});
