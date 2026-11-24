import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { closeStorage, connectStorage, createStorageClient, readStorageCommand } from "@lotus-yunzai/storage";
import { ensureManagedValkey, stopManagedValkey } from "../lib/managed-valkey.ts";
import { copyHost } from "./host-fixture.ts";

const available = Boolean(Bun.which("valkey-server"));
test.skipIf(!available)("已完成和在途INFO取消不破坏队列，关闭按序排空写命令且并发关闭复用",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"lotus-storage-close-")),root=pathToFileURL(directory+"/");
 try {
  const prepared=await ensureManagedValkey(root,{initialize:true,env:{}});if(!prepared.connection)throw Error("no storage");
  const redis=await connectStorage(prepared.connection),lifecycle=new AbortController();
  for(let i=0;i<20;i++) {
   expect(await readStorageCommand<string>(redis,["INFO","clients"],lifecycle.signal)).toContain("connected_clients");
   expect(await readStorageCommand<string>(redis,["INFO"],lifecycle.signal)).toContain("redis_version");
  }
  lifecycle.abort(new Error("completed view cancelled"));
  const pendingController=new AbortController();
  const pending=readStorageCommand<string>(redis,["INFO"],pendingController.signal);
  pendingController.abort(new Error("in-flight view cancelled"));
  await expect(pending).rejects.toThrow("in-flight view cancelled");
  const writes=Array.from({length:200},(_,i)=>redis.set(`drain-${i}`,String(i)));
  const closing=closeStorage();expect(closeStorage()).toBe(closing);
  expect(await Promise.all(writes)).toEqual(Array(200).fill("OK"));await closing;
  expect(redis.isOpen).toBe(false);
  const check=createStorageClient(prepared.connection);check.on("error",()=>{});await check.connect();
  expect(await check.get("drain-199")).toBe("199");expect(await check.ping()).toBe("PONG");await check.disconnect();
 }finally{await closeStorage().catch(()=>{});await stopManagedValkey(root).catch(()=>{});await rm(directory,{recursive:true,force:true});}
},15_000);

test.skipIf(!available||process.platform==="win32")("活动OneBot与消息统计期间Ctrl+C正常关闭，已完成INFO随后取消保持安全",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"lotus-onebot-storage-close-")),root=pathToFileURL(directory+"/");
 let terminal:Bun.Terminal|undefined,child:Bun.Subprocess|undefined,socket:WebSocket|undefined;
 try {
  await copyHost(directory);
  const prepared=await ensureManagedValkey(root,{initialize:true,env:{}});if(!prepared.connection||typeof prepared.connection==="string")throw Error("no private storage");
  await mkdir(join(directory,"config"),{recursive:true});
  await writeFile(join(directory,"config/redis.yaml"),Bun.YAML.stringify({socket:prepared.connection.socketPath,password:prepared.connection.password}));
  await writeFile(join(directory,"config/other.yaml"),'master: ["stdin:stdin", "10000:42"]\n');
  await writeFile(join(directory,"config/bot.yaml"),'online_msg_exp: 0\nmsg_type_count: true\ncache_group_member: false\n');
  const plugin=join(directory,"plugins/shutdown-probe");await mkdir(plugin);
  await writeFile(join(plugin,"package.json"),JSON.stringify({name:"shutdown-probe",type:"module",lotusYunzai:{entry:"index.ts"}}));
  const storageSource=pathToFileURL(join(import.meta.dir,"../packages/storage/index.ts")).href;
  await writeFile(join(plugin,"index.ts"),`import {readStorageCommand} from ${JSON.stringify(storageSource)};
   export function createModule({signal}) {return {commands:{"#关闭队列样本":async()=>{
    await readStorageCommand(globalThis.redis,["INFO","clients"],signal);
    await readStorageCommand(globalThis.redis,["INFO"],signal);
    await globalThis.redis.set("shutdown-proof","persisted");return "queue-reads-completed";
   }}};}`);
  let text="";terminal=new Bun.Terminal({cols:120,rows:30,data:(_t,c)=>{text+=Buffer.from(c).toString()}});
  child=Bun.spawn([process.execPath,"app.ts"],{cwd:directory,env:{PATH:process.env.PATH,LOTUS_HTTP_PORT:"0",LOTUS_ONEBOT_PORT:"0",LOTUS_SYSTEM_STATUS_THEME_DIR:join(directory,"no-status-artwork")},terminal});
  async function until(test:()=>boolean,label:string){for(let i=0;i<200;i++){if(test())return;if(child?.exitCode!==null)throw Error(label+": host exited\n"+text);await Bun.sleep(20);}throw Error(label+"\n"+text);}
  await until(()=>text.includes("Lotus-Yunzai 已启动"),"startup");
  const endpoint=/ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(text)?.[0];if(!endpoint)throw Error("missing WS endpoint");
  const Client=WebSocket as unknown as new(url:string,options:Bun.WebSocketOptions)=>WebSocket;
  socket=new Client(endpoint,{headers:{"X-Client-Role":"Universal","X-Self-ID":"10000"}});
  let delivered=0;const active=socket;
  active.addEventListener("message",({data})=>{
   const frame=JSON.parse(String(data));let result:unknown={};
   if(frame.action==="get_login_info")result={user_id:10000,nickname:"shutdown fixture"};
   if(frame.action==="get_friend_list")result=[{user_id:42,nickname:"fixture"}];
   if(frame.action==="get_group_list")result=[{group_id:66,group_name:"fixture"}];
   if(frame.action==="get_group_member_info")result={user_id:frame.params.user_id,role:"owner",nickname:"fixture"};
   if(frame.action?.startsWith("send_")){delivered++;result={message_id:delivered};}
   if(active.readyState===WebSocket.OPEN)active.send(JSON.stringify({status:"ok",retcode:0,data:result,echo:frame.echo}));
  });
  await until(()=>active.readyState===WebSocket.OPEN,"WS connect");
  active.send(JSON.stringify({post_type:"meta_event",meta_event_type:"lifecycle",sub_type:"connect",self_id:10000}));
  const message=(id:number,msg:string,group=false)=>active.send(JSON.stringify({post_type:"message",message_type:group?"group":"private",sub_type:group?"normal":"friend",self_id:10000,user_id:42,...(group?{group_id:66}:{}),message_id:id,time:Math.floor(Date.now()/1000),raw_message:msg,message:msg,sender:{user_id:42,nickname:"fixture",role:"owner"}}));
  for(let i=0;i<4;i++)message(i+1,"#状态");
  await until(()=>delivered>=1,"OneBot status replies");
  terminal.write("#关闭队列样本\r");await until(()=>text.includes("queue-reads-completed"),"INFO reads");
  for(let i=0;i<100;i++)message(100+i,"shutdown-count-sample",true);
  terminal.write("\x03");
  await until(()=>child!.exitCode!==null,"Ctrl+C exit");
  expect(await child.exited).toBe(0);expect(text).toContain("结束运行");expect(text).not.toContain("queue.shift");expect(text).not.toContain("TypeError");
  const check=createStorageClient(prepared.connection);check.on("error",()=>{});await check.connect();
  expect(await check.get("shutdown-proof")).toBe("persisted");expect(await check.ping()).toBe("PONG");await check.disconnect();
 }finally{
  socket?.close();if(child?.exitCode===null){child.kill("SIGKILL");await child.exited;}terminal?.close();
  await stopManagedValkey(root).catch(()=>{});await rm(directory,{recursive:true,force:true});
 }
},20_000);

test.skipIf(!available)("阻塞命令令关闭超时时保留错误并销毁传输，不悬挂或隐藏失败",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"lotus-storage-close-timeout-")),root=pathToFileURL(directory+"/");
 try {
  const prepared=await ensureManagedValkey(root,{initialize:true,env:{}});if(!prepared.connection)throw Error("no storage");
  const redis=await connectStorage(prepared.connection);
  const blocked=redis.blPop("shutdown-blocked",0).catch(error=>error);
  const started=Date.now();await expect(closeStorage()).rejects.toThrow("Valkey 关闭超时");
  expect(Date.now()-started).toBeLessThan(7_000);
  expect(await blocked).toBeInstanceOf(Error);expect(redis.isOpen).toBe(false);
  const healthy=createStorageClient(prepared.connection);healthy.on("error",()=>{});await healthy.connect();
  expect(await healthy.ping()).toBe("PONG");await healthy.disconnect();
 }finally{await closeStorage().catch(()=>{});await stopManagedValkey(root).catch(()=>{});await rm(directory,{recursive:true,force:true});}
},12_000);
