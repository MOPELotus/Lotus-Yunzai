import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { readRegistrationTime } from "../packages/hoyo-client/registration-time.ts";
import { createAnniversaryStore } from "../lib/legacy-anniversary.ts";

for (const game of ["gs", "sr", "zzz"] as const) test(`${game}注册时间经badge会话读取，验证角色且不跨域传递原账号Cookie`, async () => {
  const role = { chosen: true, nickname: "fixture", uid: "123456789", region: game === "gs" ? "cn_gf01" : "prod_gf_cn", gameBiz: {gs:"hk4e_cn",sr:"hkrpg_cn",zzz:"nap_cn"}[game] };
  const source = { game, role, account: { cookie: "ltoken=fixture-private" } } as ProfileRequestContext;
  const calls: string[] = [];
  const result = await readRegistrationTime(source, async (url, init) => {
    calls.push(url.pathname);
    expect(init.redirect).toBe("error");
    if (calls.length === 1) {
      expect(new Headers(init.headers).get("Cookie")).toBe("ltoken=fixture-private");
      return Response.json({retcode:0,data:{ game_uid:role.uid,region:role.region,game_biz:role.gameBiz }}, {headers:{"Set-Cookie":"activity=fixture-session; HttpOnly"}});
    }
    expect(new Headers(init.headers).get("Cookie")).toBe("activity=fixture-session");
    return Response.json({retcode:0,data:game === "gs" ? {data:{"1":1704200000}} : {raw_data:JSON.stringify(game === "sr" ? {"1-1":"2024-01-03"} : {"1":1704200000})}});
  }, {});
  expect(calls).toHaveLength(2);
  expect(result.info_data.game_uid).toBe(role.uid);
  expect(JSON.stringify(result)).not.toContain("fixture-session");
  const root = await mkdtemp(join(tmpdir(), "lotus-registration-native-"));
  try {
    const store = createAnniversaryStore(root), active = new AbortController().signal;
    await store.save(game,"42",role,result,active);
    expect((await store.read(game,"42",active))?.[role.uid]).toBeDefined();
    const content = await readFile(join(root,"data/anniversary",game,"42.json"),"utf8");
    expect(content).not.toContain("ltoken");
    await expect(store.save(game,"42",{...role,uid:"999999999"},result,active)).rejects.toThrow("不匹配");
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("badge返回错误角色时不继续查询活动", async () => {
  let calls = 0;
  const source = {game:"gs",role:{uid:"123456789",region:"cn_gf01",gameBiz:"hk4e_cn"},account:{cookie:"ltoken=fixture"}} as ProfileRequestContext;
  await expect(readRegistrationTime(source, async () => { calls++; return Response.json({retcode:0,data:{game_uid:"999999999",region:"cn_gf01",game_biz:"hk4e_cn"}}); }, {})).rejects.toThrow("不一致");
  expect(calls).toBe(1);
});
