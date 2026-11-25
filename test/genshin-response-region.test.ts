import { expect, test } from "bun:test";
import type { ProfileRequestContext } from "../packages/account/index.ts";
import { createGenshinChallengeReader, createGenshinPersonalRecordReader, verifyRole } from "../packages/hoyo-client/genshin-panel.ts";
import { normalizeGenshinWorldBoss } from "../packages/hoyo-client/genshin-world-boss.ts";

for (const [region, display, uid] of [["cn_gf01", "天空岛", "123456789"], ["cn_qd01", "世界树", "523456789"]] as const) {
  test(`${display}显示名只在响应身份核验中规范化，保留代码请求和原始业务数据`, async () => {
    const data = { uid, server: region, game_biz: "hk4e_cn", role: { game_uid: uid, region: display }, world_explorations: [] };
    expect(() => verifyRole(data, uid, region)).not.toThrow();
    expect(() => verifyRole({ uid, region: display, role: { server: region } }, uid, region)).not.toThrow();
    expect(normalizeGenshinWorldBoss(data, { uid, region })).toMatchObject({ uid, region, status: "available", groups: [] });
    const source = { qq: "42", profileId: 1, revision: "fixture", game: "gs",
      role: { uid, region, gameBiz: "hk4e_cn" }, account: { cookie: "cookie_token=fixture" },
      device: { id: "fixture-device", fp: "fixture-fp" } } as ProfileRequestContext;
    const calls: URL[] = [];
    const transport = async (url: URL) => {
      calls.push(url);
      expect(url.searchParams.get("server")).toBe(region);
      return Response.json({ retcode: 0, data });
    };
    const record = await createGenshinPersonalRecordReader(false)(source, transport, {});
    expect(record.overview.role).toEqual(data.role);
    for (const options of [{ mode: "abyss", scheduleType: 1 }, { mode: "theater" }] as const) {
      const result = await createGenshinChallengeReader()(source, transport, options);
      expect(result.overview.role).toEqual(data.role);
      expect(result.challenge.role).toEqual(data.role);
    }
    expect(calls).toHaveLength(5);
  });
}

test("服务器显示名不掩盖顶层、嵌套UID/游戏/区服冲突或未知声明", () => {
  const uid = "123456789", region = "cn_gf01";
  for (const bad of [
    { region: "世界树" }, { region: "世界树", server: region },
    { server: region, role: { region: "世界树" } }, { region: "天空岛", role: { server: "cn_qd01" } },
    { region: "天空岛", role: { uid: "223456789" } }, { uid, role: { game_uid: "223456789" } },
    { region: "天空岛", game_biz: "hkrpg_cn" }, { region: "天空岛", role: { game_biz: "hk4e_global" } },
    { region: "天空岛 ", role: { server: region } }, { region: "unknown" }, { region: null }, { server: 1 },
    { region: "天空岛", role: "invalid" },
  ]) {
    expect(() => verifyRole(bad, uid, region)).toThrow();
    expect(() => normalizeGenshinWorldBoss(bad, { uid, region })).toThrow();
  }
});
