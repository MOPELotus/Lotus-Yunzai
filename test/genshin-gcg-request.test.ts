import { expect, test } from "bun:test";
import type { ProfileRequestContext } from "../packages/account/index.ts";
import type { HoyoTransport } from "../packages/hoyo-client/credentials.ts";
import { readGenshinDecks, readGenshinGcgCollection, readGenshinGcgSummary } from "../packages/hoyo-client/genshin-gcg.ts";

const entries = [
  { name: "basicInfo", path: "/basicInfo", read: (s: ProfileRequestContext,t: HoyoTransport) => readGenshinGcgSummary(s,t,{}) },
  { name: "deckList", path: "/deckList", read: (s: ProfileRequestContext,t: HoyoTransport) => readGenshinDecks(s,t,{}) },
  { name: "cardList角色", path: "/cardList", read: (s: ProfileRequestContext,t: HoyoTransport) => readGenshinGcgCollection(s,t,{scope:"character"}) },
  { name: "cardList行动", path: "/cardList", read: (s: ProfileRequestContext,t: HoyoTransport) => readGenshinGcgCollection(s,t,{scope:"action"}) },
];
function source(region = "cn_gf01") {
  return { qq:"42",profileId:1,revision:"fixture",game:"gs",account:{cookie:"cookie_token=fixture-token"},
    role:{uid:region === "cn_qd01" ? "523456789" : "123456789",region,gameBiz:"hk4e_cn"},device:{id:"fixture-device",fp:"fixture-fp"} } as ProfileRequestContext;
}
function payload(s: ProfileRequestContext, region: string) {
  return { uid:s.role.uid,server:s.role.region,role:{game_uid:s.role.uid,region,game_biz:"hk4e_cn"},nickname:"合成样本",level:1,
    avatar_card_num_gained:1,avatar_card_num_total:10,action_card_num_gained:1,action_card_num_total:20,
    deck_list:[{id:1,avatar_cards:[{name:"样本角色",num:1}],action_cards:[]}],card_list:[{name:"样本卡牌",num:1}] };
}
for (const entry of entries) {
  for (const [region,display] of [["cn_gf01","天空岛"],["cn_qd01","世界树"]] as const) {
    test(`七圣${entry.name}接受同区显示名且继续使用档案区服代码请求：${display}`, async () => {
      const s=source(region), calls:URL[]=[];
      const result = await entry.read(s,async (url,init) => {
        calls.push(url);
        expect(url.origin).toBe("https://api-takumi-record.mihoyo.com");
        expect(url.searchParams.get("role_id")).toBe(s.role.uid);
        expect(url.searchParams.get("server")).toBe(region);
        expect(init.redirect).toBe("error");
        return Response.json({retcode:0,data:payload(s,display)});
      });
      expect(result.uid).toBe(s.role.uid);
      expect(calls.at(-1)!.pathname.endsWith(entry.path)).toBe(true);
      if (entry.path === "/cardList") expect(calls).toHaveLength(2);
    });
  }
  test(`七圣${entry.name}不因同区显示名忽略UID、游戏、区服冲突或畸形role`, async () => {
    const s=source();
    for (const conflict of [
      {uid:"223456789"},{region:"世界树"},{game_biz:"hkrpg_cn"},
      {role:{game_uid:"223456789",region:"天空岛"}},
      {role:{uid:s.role.uid,region:"世界树"}},
      {role:{uid:s.role.uid,region:"天空岛",server:"cn_qd01"}},
      {role:{uid:s.role.uid,region:"天空岛",game_biz:"hk4e_global"}},
      {region:"天空岛 "},{region:null},{role:"invalid"},{role:[]},{server:1},
    ]) {
      await expect(entry.read(s,async url=>Response.json({retcode:0,data:{...payload(s,"天空岛"),
        ...(url.pathname.endsWith(entry.path) && conflict)}}))).rejects.toMatchObject({code:"response"});
    }
  });
}
