import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createHoYoLabLogin, HoYoLabLoginError } from "../packages/hoyo-client/hoyolab-login.ts";
import { createHoYoLabLoginWeb } from "../lib/hoyolab-login-web.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";
import { gameCheckinCommands } from "../lib/game-checkin-commands.ts";
import { createHoYoLabCredentialRenewal } from "../lib/hoyolab-login-renewal.ts";
import { createProfileStore } from "../packages/account/index.ts";
import type { HoyoTransport } from "../packages/hoyo-client/credentials.ts";
import type { MessageFallbackContext } from "../lib/commands.ts";
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, {recursive:true,force:true}); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "lotus-hoyolab-login-")); directories.push(path); return path; }
const credentials = { accountId: "4202", mid: "fixture-mid", stoken: "v2_fixture-stoken", deviceId: "fixture-device", realm: "SG" as const,
  cookie: "account_id_v2=4202; cookie_token_v2=fixture-cookie; account_mid_v2=fixture-mid",
  activityCookie: "ltuid_v2=4202; ltoken_v2=fixture-ltoken; ltmid_v2=fixture-mid" };
const roles = { gs: [{uid:"800000001",region:"os_asia",nickname:"fixture",gameBiz:"hk4e_global",chosen:true}], sr:[],zzz:[] };
const complete = () => Response.json({retcode:0,data:{token:{token:credentials.stoken},user_info:{aid:"4202",mid:"fixture-mid"}}});
function proof() { return Response.json({retcode:0,data:{user_info:{aid:"4202",mid:"fixture-mid"}}}); }
function transportRecorder(login: (headers: Headers, body: Record<string,unknown>) => Response | Promise<Response> = complete) {
  const calls: Array<{url:URL;headers:Headers;body:Record<string,unknown>}> = [];
  const transport: HoyoTransport = async (url, init) => {
    const headers = new Headers(init.headers), body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({url,headers,body});
    if (url.pathname.endsWith("appLoginByPassword")) return login(headers,body);
    if (url.pathname.endsWith("getBySToken")) return Response.json({retcode:0,data:{tokens:[{token_type:2,token:"fixture-ltoken"},{token_type:4,token:"fixture-cookie"}]}});
    if (/verifyCookieToken|verifyLToken/u.test(url.pathname)) return proof();
    if (url.pathname.includes("getUserGameRoles")) return Response.json({retcode:0,data:{list:url.searchParams.get("game_biz")==="hk4e_global"?[{game_uid:"800000001",region:"os_asia",nickname:"fixture",is_chosen:true}]:[]}});
    if (url.pathname.includes("verifyActionTicketPartly") || url.pathname.includes("createEmailCaptcha")) return Response.json({retcode:0,data:{}});
    throw Error(`unexpected route ${url.pathname}`);
  };
  return {calls,transport};
}

test("HoYoLAB app login signs the exact RSA payload, exchanges both tokens and verifies the account", async () => {
  const {calls,transport} = transportRecorder();
  const client = createHoYoLabLogin(transport), login = client.start("fixture-device");
  const result = await login.password("fixture@example.invalid", "fixture-password");
  expect(result.state).toBe("complete");
  const request = calls[0]!;
  expect(JSON.stringify(request.body)).not.toContain("fixture-password");
  expect(JSON.stringify(request.body)).not.toContain("fixture@example.invalid");
  expect(Buffer.from(String(request.body.account),"base64").length).toBe(256);
  const [time,nonce,signature] = request.headers.get("ds")!.split(",");
  expect(signature).toBe(createHash("md5").update(`salt=IZPgfb0dRPtBeLuFkdDznSZ6f4wWt6y2&t=${time}&r=${nonce}&b=${JSON.stringify(request.body)}&q=`).digest("hex"));
  if(result.state!=="complete") throw Error();
  const exchanged = await client.exchange(result.credentials);
  expect(exchanged).toEqual(credentials);
  expect(calls.map(call=>call.url.hostname)).toEqual(["sg-public-api.hoyoverse.com","sg-public-api.hoyoverse.com","passport-api-sg.hoyolab.com","passport-api-sg.hoyolab.com"]);
  expect(calls[1]!.headers.get("cookie")).toContain("mid=fixture-mid");
  expect(calls[1]!.body).toEqual({dst_token_types:[2,4]});
  expect(calls[2]!.headers.get("cookie")).not.toContain("stoken");
});

test("HoYoLAB V4 and email verification retain one device and action ticket, without sending the first email twice", async () => {
  let logins = 0;
  const ticket = {risk_ticket:"risk-fixture",verify_str:JSON.stringify({ticket:"action-fixture",verify_type:"email"})};
  const {calls,transport} = transportRecorder(headers => {
    logins++;
    if(logins===1) return Response.json({retcode:-3101,data:null},{headers:{"x-rpc-aigis":JSON.stringify({session_id:"session-fixture",data:JSON.stringify({use_v4:true,gt:"captcha-fixture",risk_type:"slide"})})}});
    if(logins===2) {
      const [session,encoded]=headers.get("x-rpc-aigis")!.split(";");
      expect(session).toBe("session-fixture"); expect(JSON.parse(Buffer.from(encoded!,"base64").toString()).captcha_id).toBe("captcha-fixture");
      return Response.json({retcode:-3239,data:null},{headers:{"x-rpc-verify":JSON.stringify(ticket)}});
    }
    expect(JSON.parse(headers.get("x-rpc-verify")!)).toEqual(ticket);
    return complete();
  });
  const login = createHoYoLabLogin(transport).start("fixture-device");
  expect((await login.password("test@example.invalid","fixture")).state).toBe("captcha");
  await expect(login.captcha({captcha_id:"wrong"})).rejects.toBeInstanceOf(HoYoLabLoginError);
  expect((await login.captcha({captcha_id:"captcha-fixture",lot_number:"lot",pass_token:"pass",gen_time:"1",captcha_output:"output"})).state).toBe("email");
  expect(calls.some(call=>call.url.pathname.includes("createEmailCaptcha"))).toBe(false);
  expect((await login.verifyEmail("123456")).state).toBe("complete");
  expect(calls.map(call=>call.headers.get("x-rpc-device_id"))).toEqual(["fixture-device","fixture-device","fixture-device","fixture-device"]);
  expect(calls[2]!.body).toEqual({action_type:"verify_for_component",action_ticket:"action-fixture",email_captcha:"123456",verify_method:2});
  login.destroy(); await expect(login.password("test","fixture")).rejects.toBeInstanceOf(HoYoLabLoginError);
});

test("overseas-only profile is independently usable for checkin and role selection, never a domestic passport", async () => {
  const path = await directory(), store = createProfileStore(path), slot = await store.openLoginSlot("42",2);
  const saved = await store.saveInternationalLogin(slot,credentials,roles,undefined,91);
  expect((await store.summary("42",2)).loggedIn).toBe(true);
  await expect(store.accountContext("42",2)).rejects.toMatchObject({code:"login-required"});
  expect((await store.checkinSettings("42",2)).games.genshin?.enabled).toBe(false);
  expect((await store.checkinAccountContext("42",2)).account.cookie).toBe("");
  expect((await store.internationalRoleContext("42",2,"gs"))?.selectedUid).toBe("800000001");
  expect((await store.internationalCheckin("42",2,"genshin")).status).toBe("verified");
  expect((await store.internationalCheckin("42",2,"honkai_sr")).status).toBe("disabled");
  expect((await store.checkinSettings("42",2)).notify.fallbackGroups).toEqual([91]);
  expect((await store.roleCatalog("42",2)).catalog.gs).toHaveLength(1);
  const next = await store.setCheckinEnabled("42",2,saved.revision,true);
  expect(next.enabled).toBe(true);
  await store.clearLogin("42",2);
  expect((await store.summary("42",2)).loggedIn).toBe(false);
  expect(await store.internationalCredentials("42",2)).toBeUndefined();
});

test("overseas login preserves domestic account, unrelated settings and optimistic revision checks", async () => {
  const path=await directory(),store=createProfileStore(path);
  await writeFile(join(path,"42.yaml"),Bun.YAML.stringify({version:1,user:{qq:"42"},profile:{id:1},account:{cookie:"domestic-cookie",stoken:"domestic-stoken"},games:{cn:{enable:true}},schedule:{mode:"fixed",fixed_time:"12:34"}}));
  const first=await store.openLoginSlot("42"), stale=await store.openLoginSlot("42");
  await store.saveInternationalLogin(first,credentials,roles);
  await expect(store.saveInternationalLogin(stale,credentials,roles)).rejects.toMatchObject({code:"changed"});
  const document=Bun.YAML.parse(await readFile(join(path,"42.yaml"),"utf8")) as {account:unknown;schedule:unknown;games:{cn:unknown;os:{stoken:string}}};
  expect(document.account).toEqual({cookie:"domestic-cookie",stoken:"domestic-stoken"});
  expect(document.schedule).toEqual({mode:"fixed",fixed_time:"12:34"});
  expect(document.games.cn).toEqual({enable:true});
  expect(document.games.os.stoken).toBe(credentials.stoken);
});

async function webFixture(delayMs = 0) {
  const path=await directory(),controller=new AbortController(),connection=new AbortController(),{calls,transport}=transportRecorder(async()=>{if(delayMs)await Bun.sleep(delayMs);return complete();});
  const web=createHoYoLabLoginWeb({directory:path,signal:controller.signal,publicBase:()=>new URL("https://bot.example.invalid"),transport,assetDirectory:new URL("../web/hoyolab-login/",import.meta.url)});
  const context={normalizedMessage:"#国际服登录2",message_type:"group",sub_type:"normal",user_id:42,self_id:99,group_id:91,message_id:1,sender:{user_id:42},groupActivitySignal:connection.signal,reply:()=>true,isMaster:false,isBotMaster:()=>false} as MessageFallbackContext;
  const reply=String(await web.commands.fallback?.("",context));const link=new URL(reply.match(/https:\/\/\S+/u)![0]);
  const request=(action:string,body:unknown={},headers:Record<string,string>={})=>web.handle(new Request(`https://bot.example.invalid/hoyolab-login/${action}`,{method:"POST",headers:{Origin:"https://bot.example.invalid","Content-Type":"application/json",Authorization:`Bearer ${link.hash.slice(1)}`,...headers},body:JSON.stringify(body)}));
  return {web,path,controller,connection,context,request,calls,token:link.hash.slice(1)};
}

test("QQ-bound webpage commits a verified standalone profile, rejects CSRF and consumes the one-time session", async () => {
  const f=await webFixture();
  try {
    expect((await f.request("password",{}, {Origin:"https://other.invalid"}))?.status).toBe(403);
    const result=await f.request("password",{account:"test@example.invalid",password:"fixture-password"});
    expect(result?.status).toBe(200);
    const store=createProfileStore(f.path);
    expect((await store.summary("42",2)).loggedIn).toBe(true);
    expect(await readFile(join(f.path,"42-2.yaml"),"utf8")).not.toContain("fixture-password");
    expect((await f.request("status"))?.status).toBe(401);
    expect(f.calls.filter(call=>call.url.pathname.includes("getUserGameRoles"))).toHaveLength(3);
  } finally {f.controller.abort();}
});

test("QQ disconnect and a changed profile prevent late writes, with no raw provider errors exposed", async () => {
  const f=await webFixture();
  try {
    f.connection.abort(); expect((await f.request("password",{account:"a",password:"b"}))?.status).toBe(401);
    expect(f.calls).toHaveLength(0);
  } finally {f.controller.abort();}
  const other=await webFixture();
  try {
    await writeFile(join(other.path,"42-2.yaml"),Bun.YAML.stringify({user:{qq:"42"},profile:{id:2}}));
    expect((await other.request("password",{account:"a",password:"b"}))?.status).toBe(409);
    expect(other.calls).toHaveLength(0);
  } finally {other.controller.abort();}
});

test("automatic renewal only exchanges stale overseas tokens, keeps registration and never starts password/captcha flow", async () => {
  const path=await directory(),store=createProfileStore(path),slot=await store.openLoginSlot("42",2);
  await store.saveInternationalLogin(slot,credentials,roles);
  const controller=new AbortController(),recorded=transportRecorder(),warnings:string[]=[];
  const renewal=createHoYoLabCredentialRenewal(store,recorded.transport,controller.signal,{now:()=>Date.now()+3*3600000,warn:()=>warnings.push("failed")});
  try {
    await Promise.all([renewal.run(),renewal.run()]);
    expect(recorded.calls).toHaveLength(3);
    expect(recorded.calls.some(call=>call.url.pathname.includes("appLogin"))).toBe(false);
    expect((await store.internationalCredentials("42",2))?.stoken).toBe(credentials.stoken);
    expect((await store.checkinSettings("42",2)).enabled).toBe(false);
    expect(warnings).toEqual([]);
  } finally {controller.abort();}
});

test("a newly logged overseas-only account reaches the existing manual checkin service without domestic refresh", async () => {
  const path=await directory(),store=createProfileStore(path),slot=await store.openLoginSlot("42",2);
  await store.saveInternationalLogin(slot,credentials,roles);
  const controller=new AbortController(),calls:string[]=[];
  const runner=gameCheckinCommands(path,controller.signal,{scheduleStore:createCheckinScheduleStore(join(path,"schedules")),async renderReceipt(){throw Error("text-only fixture");},async transport(url,init){
    calls.push(url.href);expect(url.hostname).not.toContain("mihoyo.com");expect(new Headers(init.headers).get("Cookie")).toBe(credentials.cookie);
    if(url.pathname.includes("getUserGameRoles")) return Response.json({retcode:0,data:{list:[{game_uid:"800000001",region:"os_asia"}]}});
    if(url.pathname==="/event/sol/info") return Response.json({retcode:0,data:{is_sign:true,total_sign_day:1}});
    throw Error(`unexpected route ${url.pathname}`);
  }});
  try {
    const result=await runner.runWeb("42",2,{signal:controller.signal,verifySession:async()=>{}});
    expect(result.status).toBe("completed");
    expect(result.message).toContain("国际服已完成");
    expect(calls).toHaveLength(2);
  } finally {controller.abort();}
});

test("V3 proof and captcha on email resend resume the correct blocked operation", async () => {
  let appCalls=0,resendCalls=0;
  const ticket={risk_ticket:"risk",verify_str:JSON.stringify({ticket:"ticket",verify_type:"email"})};
  const v3=()=>Response.json({retcode:-3101,data:null},{headers:{"x-rpc-aigis":JSON.stringify({session_id:"v3-session",data:{gt:"gt-fixture",challenge:"challenge-fixture",use_v4:false}})}});
  const transport:HoyoTransport=async(url,init)=>{
    if(url.pathname.endsWith("appLoginByPassword")) {
      appCalls++;if(appCalls===1)return v3();
      return Response.json({retcode:-3239,data:null},{headers:{"x-rpc-verify":JSON.stringify(ticket)}});
    }
    if(url.pathname.includes("createEmailCaptcha")) {
      resendCalls++;if(resendCalls===1)return v3();
      expect(new Headers(init.headers).get("x-rpc-aigis")).toContain("v3-session;");return Response.json({retcode:0,data:{}});
    }
    throw Error();
  };
  const login=createHoYoLabLogin(transport).start("device");
  expect((await login.password("account","password")).state).toBe("captcha");
  const result={geetest_challenge:"challenge-fixture",geetest_validate:"validate",geetest_seccode:"validate|jordan"};
  expect((await login.captcha(result)).state).toBe("email");
  expect((await login.resend()).state).toBe("captcha");
  expect((await login.captcha(result)).state).toBe("email");
  expect(appCalls).toBe(2);expect(resendCalls).toBe(2);
});

test("raw authentication errors stay private and failed exchange does not create a partial profile",async()=>{
  const path=await directory(),controller=new AbortController(),connection=new AbortController();
  const client=transportRecorder(()=>Response.json({retcode:-200,message:"private-provider-detail fixture-password",data:null}));
  const web=createHoYoLabLoginWeb({directory:path,signal:controller.signal,publicBase:()=>new URL("https://bot.example.invalid"),transport:client.transport,assetDirectory:new URL("../web/hoyolab-login/",import.meta.url)});
  try{
    const context={normalizedMessage:"#国际服登录",message_type:"private",sub_type:"friend",user_id:42,self_id:99,privateCredentialSignal:connection.signal,reply:()=>true,isMaster:false,isBotMaster:()=>false}as MessageFallbackContext;
    const reply=String(await web.commands.fallback?.("",context));const token=new URL(reply.match(/https:\/\/\S+/u)![0]).hash.slice(1);
    const response=await web.handle(new Request("https://bot.example.invalid/hoyolab-login/password",{method:"POST",headers:{Origin:"https://bot.example.invalid","Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({account:"account",password:"fixture-password"})}));
    const body=await response!.text();expect(body).toContain("-200");expect(body).not.toContain("private-provider-detail");expect(body).not.toContain("fixture-password");
    await expect(createProfileStore(path).summary("42")).rejects.toMatchObject({code:"missing"});
  }finally{controller.abort();}
});

test("renewal defers while a checkin execution slot is held",async()=>{
  const path=await directory(),store=createProfileStore(path),slot=await store.openLoginSlot("42",2);
  await store.saveInternationalLogin(slot,credentials,roles);
  const recorded=transportRecorder(),controller=new AbortController();
  const renewal=createHoYoLabCredentialRenewal(store,recorded.transport,controller.signal,{now:()=>Date.now()+3*3600000,
    withIdleSlot:async()=>({acquired:false}),warn:()=>{throw Error("defer is not an error");}});
  try{await renewal.run();expect(recorded.calls).toHaveLength(0);}finally{controller.abort();}
});

test("mixed domestic and overseas login lists both regions and selects overseas roles without a domestic credential request", async () => {
  const path=await directory(),store=createProfileStore(path);
  await writeFile(join(path,"42.yaml"),Bun.YAML.stringify({version:1,user:{qq:"42"},profile:{id:1},account:{cookie:"domestic-cookie",stoken:"domestic-stoken",
    game_roles:{gs:[{uid:"100000001",region:"cn_gf01",game_biz:"hk4e_cn",nickname:"domestic"}]},current_uid:{gs:"100000001"}}}));
  await store.saveInternationalLogin(await store.openLoginSlot("42"),credentials,roles);
  const catalog=await store.roleCatalog("42",1);
  expect(catalog.catalog.gs.map(role=>role.uid)).toEqual(["100000001","800000001"]);
  expect(catalog.active.gs).toBe("100000001");
  const controller=new AbortController();
  await store.selectCatalogRole("42",1,"gs","800000001",catalog.revision,controller.signal,()=>true);
  expect((await store.savedRole("42",1,"gs")).region).toBe("os_asia");
  const international = await store.requestSelectedContext("42",1,"gs");
  expect(international.international?.accountId).toBe(credentials.accountId);
  expect(international.account.cookie).toBe("");
  expect((await store.requestContext("42",1,"gs")).role.region).toBe("os_asia");
  expect((await store.accountContext("42",1)).account.cookie).toBe("domestic-cookie");
  const view=await store.describe("42",1);
  expect(view.international.roles.gs).toHaveLength(1);
  expect(view.international.activeRoles.gs).toBe("800000001");
});

test("login endpoints extend Bun request timeout without changing other routes", async () => {
  const f=await webFixture();let calls=0;
  const server={timeout(_request:Request,seconds:number){expect(seconds).toBe(120);calls++;}};
  try{
    await f.web.handle(new Request("https://bot.example.invalid/hoyolab-login/status",{method:"POST"}),server);
    expect(calls).toBe(1);
    await f.web.handle(new Request("https://bot.example.invalid/status",{method:"POST"}),server);
    await f.web.handle(new Request("https://bot.example.invalid/hoyolab-login/"),server);
    expect(calls).toBe(1);
  }finally{f.controller.abort();}
});

test("login list includes saved international UIDs alongside the domestic selection",async()=>{
  const {accountCommands}=await import("../lib/account-commands.ts");
  const path=await directory(),store=createProfileStore(path);
  await writeFile(join(path,"42.yaml"),Bun.YAML.stringify({version:1,user:{qq:"42"},profile:{id:1},account:{cookie:"domestic-cookie",stoken:"domestic-stoken",current_uid:{gs:"100000001"}}}));
  await store.saveInternationalLogin(await store.openLoginSlot("42"),credentials,roles);
  const module=accountCommands(path,()=>true);
  const result=await module.commands["#登录列表"]!("",{message_type:"private",user_id:42,isMaster:false,reply:()=>true});
  expect(result).toContain("800000001");expect(result).toContain("国际服");
  expect(result).not.toContain("fixture-stoken");
});

test("a login taking longer than Bun's default idle limit still returns its completed response",async()=>{
  const f=await webFixture(11_000);
  const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request,server){return await f.web.handle(request,server)??new Response(null,{status:404});}});
  try{
    const response=await fetch(new URL("/hoyolab-login/password",server.url),{method:"POST",signal:AbortSignal.timeout(16_000),
      headers:{Origin:"https://bot.example.invalid","Content-Type":"application/json",Authorization:`Bearer ${f.token}`},
      body:JSON.stringify({account:"test@example.invalid",password:"fixture-password"})});
    expect(response.status).toBe(200);expect((await response.json()).state).toBe("complete");
  }finally{f.controller.abort();await server.stop(true);}
},18_000);
