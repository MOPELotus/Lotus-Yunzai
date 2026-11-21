import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModule } from "../plugins/zzz/index.ts";

test("绝区零私有命令拒绝手动选择但未认证的 UID，随后只查询实际选择的角色", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-zzz-private-role-"));
  const previous = Bun.env.LOTUS_PROFILE_DIR;
  const request = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ retcode: 0, data: {} }));
  try {
    Bun.env.LOTUS_PROFILE_DIR = directory;
    const save = (selected: string) => writeFile(join(directory, "42-3.yaml"), `
account:
  ltuid: "400001"
  cookie: ltoken=fixture-private-role
  stoken: fixture-private-stoken
  current_uid: { zzz: "${selected}" }
  game_roles:
    zzz:
      - { uid: "12345678", region: prod_gf_cn, game_biz: nap_cn, is_chosen: true }
      - { uid: "92345678", region: prod_qd_cn, game_biz: nap_cn }
device: { id: fixture-device, fp: fixture-fp }
`);
    const module = createModule({ signal: new AbortController().signal, lockFile: async () => {
      throw new Error("战绩读取不需要写锁。");
    } });
    const run = (message: string) => module.fallback(message, {
      normalizedMessage: message, message_type: "private", user_id: 42, self_id: 99, reply: () => true,
    });
    await save("32345678");
    for (const command of ["%card3", "%获取抽卡链接3", "%迷宫战绩3 页 2", "%探索度3", "%临界3", "%爬塔3", "%迷失3"]) {
      expect(await run(command)).toContain("未选中已认证的绝区零 UID");
    }
    expect(request).not.toHaveBeenCalled();

    await save("92345678");
    expect(await run("%临界3")).toBe("本期暂无临界推演战绩。");
    expect(request).toHaveBeenCalledTimes(1);
    const url = new URL(String(request.mock.calls[0]?.[0]));
    expect(url.searchParams.get("uid")).toBe("92345678");
    expect(url.searchParams.get("region")).toBe("prod_qd_cn");
  } finally {
    request.mockRestore();
    if (previous === undefined) delete Bun.env.LOTUS_PROFILE_DIR;
    else Bun.env.LOTUS_PROFILE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
