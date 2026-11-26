import {expect,test} from "bun:test";
import {createOfficialGroupPanels} from "../lib/group-panel-accounts.ts";
import type {createProfileStore, Game, ProfileRequestContext} from "@lotus-yunzai/account";

test("验证群成员通过米游社刷新面板排行及单人有效角色正常出图", async () => {
  for(const game of ["gs","sr","zzz"] as const){
    let revision="first", uid="100000042", reads=0, saves=0;
    let mutate=false, allowed=true;
    const role=()=>({uid,region:"fixture",gameBiz:"fixture",nickname:"",chosen:true});
    const profiles={
      async listCheckinProfiles(){return [
        {qq:"43",profileId:1,loggedIn:false,enabled:true},
        {qq:"42",profileId:1,loggedIn:true,enabled:false},
        {qq:"44",profileId:1,loggedIn:true,enabled:true},
        {qq:"99",profileId:1,loggedIn:true,enabled:true},
      ];},
      async savedRole(qq:string){return {...role(),uid:qq==="44"?"100000044":uid};},
      async requestContext(qq:string,profileId:number,requestGame:Game){
        expect([qq,profileId,requestGame]).toEqual(["42",1,game]);
        return {qq,profileId,game,role:role(),revision} as ProfileRequestContext;
      },
    } as unknown as ReturnType<typeof createProfileStore>;
    const source=createOfficialGroupPanels(profiles,game,async source=>{
      reads++; expect(source.role.uid).toBe("100000042");
      if(mutate)revision="second";
      return {revision:source.revision,value:1};
    },async(result,_owner,verify)=>{await verify();saves++;return result.value;});
    const signal=new AbortController().signal;
    const owners=await source.list(new Set([42,43,44]),signal);
    expect(owners.map(x=>x.qq)).toEqual([42,44]);
    expect(await source.read(owners[0]!,signal,async()=>{if(!allowed)throw Error("membership changed");},undefined)).toBe(1);
    expect([reads,saves]).toEqual([1,1]);
    mutate=true;
    await expect(source.read(owners[0]!,signal,async()=>{},undefined)).rejects.toThrow("account-changed");
    expect(saves).toBe(1);
    allowed=false;
    await expect(source.read(owners[0]!,signal,async()=>{if(!allowed)throw Error("membership changed");},undefined)).rejects.toThrow("membership changed");
    expect([reads,saves]).toEqual([2,1]);
    uid="100000045";
    await expect(source.read(owners[0]!,signal,async()=>{},undefined)).rejects.toThrow("role-changed");
    expect([reads,saves]).toEqual([2,1]);
  }
});
