import { expect, test } from "bun:test";
import type { ExecuteContext, ExecuteRequest } from "../plugins/execute/index.ts";
import { legacyGroupMemberRoster, type MemberRosterEntry } from "../lib/adapters/onebot-member-display.ts";
import { createCommandDelegation, delegationSession } from "../lib/command-delegation.ts";
import type { MessageEvent } from "../lib/messages.ts";

test("delegate exposes roster only for the active authorized group and rejects stale results", async () => {
  const lifecycle = new AbortController();
  const connection = new AbortController();
  const rosterRequest = Promise.withResolvers<void>();
  const rosterResult = Promise.withResolvers<readonly MemberRosterEntry[]>();
  const locations: number[] = [];
  const delivered: number[] = [];
  let owner = true;
  let lastRoster: MessageEvent[typeof legacyGroupMemberRoster];
  let lastReply: MessageEvent["reply"] | undefined;
  let returned: readonly MemberRosterEntry[] | undefined;
  let mode: "present" | "absent" | "disconnect" = "present";

  const dispatcher = createCommandDelegation({
    signal: lifecycle.signal,
    mayDelegate: () => owner,
    isMaster: (_bot, user) => user === 42,
    async run(event, handled) {
      expect(event.isMaster).toBe(false);
      expect(event.isDelegated).toBe(true);
      expect(event.privateCredentialSignal).toBeUndefined();
      expect(event[delegationSession]).toBeUndefined();
      lastRoster = event[legacyGroupMemberRoster];
      lastReply = event.reply;
      returned = await lastRoster?.();
      handled();
      await event.reply("fixture");
    },
  });
  const origin: MessageEvent = {
    post_type:"message",message_type:"group",sub_type:"normal",self_id:99,user_id:42,group_id:700,
    isGroup:true,isPrivate:false,isMaster:true,boundAccount:true,msg:"#代",raw_message:"#代",message:"#代",
    reply:async()=>true,
    [delegationSession]: {
      signal:connection.signal, groups:async()=>[700,701,701], members:async()=>[99,43,43],
      isFriend:async()=>true, memberRole:async()=> "member", botMute:async()=>undefined,
      async send(target) { delivered.push(target.groupId ?? target.userId); return "confirmed"; },
      async readRoster(group, active) {
        locations.push(group);
        expect(active.aborted).toBe(false);
        if (mode === "absent") return [{ id:44, card:"unrelated" }];
        if (mode === "disconnect") {
          rosterRequest.resolve();
          return rosterResult.promise;
        }
        return [{ id:43, card:"target" }];
      },
    },
  };
  const authorized = dispatcher.authorize(origin)!;
  const actor: ExecuteContext = {
    isMaster:true, message_type:"group", self_id:99, user_id:42, group_id:700, delegationSignal:authorized.event.delegationSignal,
  };
  const signal = authorized.event.delegationSignal!;
  const request = (group: ExecuteRequest["group"], users: ExecuteRequest["users"] = [43]): ExecuteRequest =>
    ({ group, users, gap:0, hold:false, command:"#群日历", segments:[{ type:"text", text:"#群日历" }] });
  async function dispatchSelected(selection: ExecuteRequest) {
    const target = (await dispatcher.execute.resolveTargets(actor,selection,signal))[0]!;
    return dispatcher.execute.dispatch(actor,target,selection,signal);
  }

  const all = request("全部群","all");
  expect(await dispatcher.execute.resolveTargets(actor,all,signal)).toEqual([{ groupId:700,userId:43 },{ groupId:701,userId:43 }]);
  expect(await dispatcher.execute.resolveTargets({ ...actor,group_id:701 },all,signal)).toEqual([]);
  expect(await dispatcher.execute.dispatch(actor,{ groupId:702,userId:43 },all,signal)).toBe("rejected");

  expect(await dispatchSelected(request(701))).toBe("handled");
  expect(returned).toEqual([{ id:43,card:"target" }]);
  expect(await lastRoster?.()).toBeUndefined();
  expect(await lastReply?.("已退出的目标回调")).toBe(false);
  expect(delivered).toEqual([701]);
  expect(locations).toEqual([701]);

  expect(await dispatchSelected(request("私聊"))).toBe("handled");
  expect(lastRoster).toBeUndefined();
  expect(locations).toEqual([701]);
  expect(delivered).toEqual([701,43]);

  mode = "absent";
  expect(await dispatchSelected(request("本群"))).toBe("handled");
  expect(returned).toBeUndefined();

  owner = false;
  expect(await dispatcher.execute.resolveTargets(actor,request("本群"),signal)).toEqual([]);
  owner = true;

  mode = "disconnect";
  const pending = dispatchSelected(request(701));
  await rosterRequest.promise;
  connection.abort();
  rosterResult.resolve([{ id:43,card:"expired" }]);
  expect(await pending).toBe("handled");
  expect(returned).toBeUndefined();
  expect(locations).toEqual([701,700,701]);
  expect(delivered).toEqual([701,43,700]);
  authorized.close();
});

test("delegated forwards retain the selected target and cannot escape hold or completed dispatch", async () => {
  const scope = new AbortController();
  const sent: Array<{groupId?:number;userId:number}> = [];
  let late: MessageEvent["forward"];
  const dispatcher = createCommandDelegation({signal:scope.signal,mayDelegate:()=>true,isMaster:()=>false,
    async run(event,handled) { handled(); late=event.forward; expect(await event.forward?.(["fixture"])).toBe(true); },
  });
  const origin: MessageEvent = {post_type:"message",message_type:"group",self_id:99,user_id:42,group_id:700,
    isMaster:true,isGroup:true,isPrivate:false,msg:"#代",raw_message:"#代",message:"#代",reply:async()=>true,
    [delegationSession]: {signal:scope.signal,groups:async()=>[700],members:async()=>[43],isFriend:async()=>true,
      memberRole:async()=>"member",botMute:async()=>undefined,send:async()=>"confirmed",
      forward:async(target)=>{sent.push(target);return "confirmed";},
    },
  };
  const authorized=dispatcher.authorize(origin)!;
  const actor: ExecuteContext={isMaster:true,message_type:"group",self_id:99,user_id:42,group_id:700,delegationSignal:authorized.event.delegationSignal};
  const active=authorized.event.delegationSignal!;
  for(const [group,hold] of [["本群",false],["私聊",false],["本群",true]] as const){
    const request:ExecuteRequest={group,users:[43],hold,gap:0,command:"%抽卡记录",segments:[{type:"text",text:"%抽卡记录"}]};
    const target=(await dispatcher.execute.resolveTargets(actor,request,active))[0]!;
    expect(await dispatcher.execute.dispatch(actor,target,request,active)).toBe("handled");
    expect(await late?.(["stale"])).toBe(false);
  }
  expect(sent).toEqual([{groupId:700,userId:43},{groupId:undefined,userId:43}]);authorized.close();
});
