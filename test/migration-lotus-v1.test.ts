import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, lstat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProfileStore } from "../packages/account/index.ts";
import { stageLegacyProfiles } from "../lib/migration-profiles.ts";
import { stageLegacyGlobalConfig } from "../lib/migration-global-config.ts";
import { stageLegacyMediaState } from "../lib/migration-media-state.ts";
import { NeteasePartnerAccounts } from "../plugins/media/services/music/partner-account.ts";
import { BilibiliService } from "../plugins/media/services/bilibili/service.ts";

async function fixture(run: (source: string, stage: string) => Promise<void>) {
  const root=await mkdtemp(join(tmpdir(),"lotus-v1-migration-"));
  try {const source=join(root,"source"),stage=join(root,"stage");await mkdir(source);await mkdir(stage,{mode:0o700});await run(source,stage);}
  finally {await rm(root,{recursive:true,force:true});}
}
async function put(root:string,path:string,value:unknown){const target=join(root,path);await mkdir(dirname(target),{recursive:true});const bytes=Bun.YAML.stringify(value);await writeFile(target,bytes);return bytes;}
const legacy={enable:true,version:15,push:"external-push-fixture",account:{cookie:"ltuid=8080;ltoken=fixture",stuid:"8080",stoken:"fixture",mid:"fixture-mid",future:"keep"},
  device:{name:"Xiaomi MI 6",model:"Mi 6",id:"fixture-id",fp:"fixture-fp",unknown:123},
  mihoyobbs:{enable:true,checkin:true,checkin_list:[1,2,6],read:false,like:true,cancel_like:false,share:true},
  games:{cn:{enable:true,genshin:{checkin:false,black_list:["100000001"]},honkai_sr:{checkin:true}},os:{enable:false}},
  cloud_games:{cn:{enable:true}},future:{nested:[1,2,3]}};

for(const directory of ["Lotus-Plugin","Lotus-ReFactor"]){
  test(`${directory} 内一代布局转换账户、设备、社区与签到设置并保留未知原件`,()=>fixture(async(source,stage)=>{
    const prefix=`plugins/${directory}`,path=`${prefix}/MihoyoBBSTools/config/42-2.yml`;
    const bytes=await put(source,path,legacy);
    const report=await stageLegacyProfiles(source,stage);
    expect(report).toMatchObject({sources:1,imported:1,firstGeneration:{deferredPush:1}});
    expect(await readFile(join(source,path),"utf8")).toBe(bytes);
    expect(await readFile(join(stage,"backup/legacy-lotus-v1",path),"utf8")).toBe(bytes);
    const store=createProfileStore(join(stage,"data/users"));
    const account=await store.accountContext("42",2);
    expect(account.account).toMatchObject({cookie:legacy.account.cookie,stuid:"8080",ltuid:"8080",stoken:"fixture",mid:"fixture-mid"});
    expect(account.device).toMatchObject({id:"fixture-id",fp:"fixture-fp",name:"Xiaomi MI 6"});
    expect(await store.summary("42",2)).toMatchObject({id:2,enabled:true,loggedIn:true,deviceBound:true});
    const settings=await store.checkinSettings("42",2);
    expect(settings).toMatchObject({games:{genshin:{enabled:false,blacklist:["100000001"]},honkai_sr:{enabled:true}},communityForums:["1","2","6"]});
    const doc=Bun.YAML.parse(await readFile(join(stage,"data/users/42-2.yaml"),"utf8")) as any;
    expect(doc.future).toEqual(legacy.future);expect(doc.account.future).toBe("keep");
    expect(doc.mihoyobbs.tasks).toEqual({checkin:true,read:false,like:true,cancel_like:false,share:true});
    expect(doc.push).toBe(legacy.push);expect(doc.profile.notify.prefer).toBe("private");
    expect((await lstat(join(stage,"data/users/42-2.yaml"))).mode&0o777).toBe(0o600);
  }));
}

test("纯一代全局固定时间、权限与嵌入的媒体账户进入当前消费者",()=>fixture(async(source,stage)=>{
  const prefix="plugins/Lotus-Plugin",path=`${prefix}/config/config.yaml`;
  await put(source,`${prefix}/MihoyoBBSTools/config/42.yaml`,legacy);
  const bytes=await put(source,path,{schedule:"0 7 3 * * *",permissionControl:{mode:"whitelist",whitelist:[42],blacklist:[43]},
    bilibili:{sessData:"fixture-session",resolution:80,durationLimit:600},
    neteasePartner:{enable:true,schedule:"0 30 0 * * *",autoCatchUp:true,accounts:[{uid:"34",qq:"42",cookie:"MUSIC_U=fixture",comment:false}]},unknown:{keep:1}});
  await stageLegacyGlobalConfig(source,stage);
  const config=Bun.YAML.parse(await readFile(join(stage,"config/global.yaml"),"utf8")) as any;
  expect(config.scheduler).toMatchObject({mode:"fixed",fixed_time:"03:07"});
  expect(config.permissions).toMatchObject({default_policy:"deny",users:{allow:["42"],deny:["43"]}});
  expect(config.netease_partner).toMatchObject({enable:true,auto_catch_up:true,schedule:"0 30 0 * * *"});
  expect(config.bilibili.download).toMatchObject({resolution:80,duration_limit_seconds:600});
  expect(await readFile(join(stage,"backup/legacy-lotus-v1",path),"utf8")).toBe(bytes);
  const media=await stageLegacyMediaState(source,stage);expect(media.held).toEqual([]);
  expect((await new NeteasePartnerAccounts(join(stage,"data/netease/accounts.yaml")).loadAccounts())[0])
    .toMatchObject({uid:"34",qq:"42",cookie:"MUSIC_U=fixture",comment:false});
  const bili=new BilibiliService({accountFile:join(stage,"data/bilibili/account.yaml"),fetch:async()=>{throw Error("no network");}});
  expect((await bili.loadAccount())?.cookie).toBe("SESSDATA=fixture-session");
  expect(await readFile(join(source,path),"utf8")).toBe(bytes);
}));

test("二代别名目录保持原字节，不因同名被当作一代重写",()=>fixture(async(source,stage)=>{
  const path="plugins/Lotus-Plugin/data/users/42.yaml";
  const bytes=await put(source,path,{version:1,enabled:false,user:{qq:"42"},profile:{id:1},account:{cookie:"",stoken:""}});
  expect(await stageLegacyProfiles(source,stage)).toEqual({sources:1,imported:1,unchanged:0});
  expect(await readFile(join(stage,"data/users/42.yaml"),"utf8")).toBe(bytes);
}));

test("混合一二代同槽位冲突拒绝覆盖；无一代布局的宿主config不误读",()=>fixture(async(source,stage)=>{
  const modern={version:1,enabled:false,user:{qq:"42"},profile:{id:1},account:{cookie:"",stoken:""}};
  const bytes=await put(source,"plugins/Lotus-Plugin/data/users/42.yaml",modern);
  await put(source,"plugins/Lotus-ReFactor/MihoyoBBSTools/config/42.yaml",legacy);
  await expect(stageLegacyProfiles(source,stage)).rejects.toThrow();
  expect(await readFile(join(stage,"data/users/42.yaml"),"utf8")).toBe(bytes);
  await put(source,"config/config.yaml",{schedule:"0 0 9 * * *"});
  await stageLegacyGlobalConfig(source,stage);
  expect(await Bun.file(join(stage,"config/global.yaml")).exists()).toBe(false);
}));

test("一代原件符号链接与冲突的扩展名别名不能激活",()=>fixture(async(source,stage)=>{
  const path="plugins/Lotus-Plugin/MihoyoBBSTools/config";
  await put(source,"outside.yaml",legacy);await mkdir(join(source,path),{recursive:true});
  await symlink(join(source,"outside.yaml"),join(source,path,"42.yaml"));
  await expect(stageLegacyProfiles(source,stage)).rejects.toThrow();
  expect(await Bun.file(join(stage,"data/users/42.yaml")).exists()).toBe(false);
}));

test.skipIf(!Bun.which("git"))("一代从纯净候选安装完整迁移，签到旧时刻保留且维护任务采用新默认",()=>fixture(async(source,stage)=>{
  const { migrateInstallation } = await import("../scripts/migrate.ts");
  const prefix="plugins/Lotus-Plugin";
  const target=join(stage,"candidate");await mkdir(target);
  const writeJson=async(root:string,path:string,value:unknown)=>{const file=join(root,path);await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value));};
  await writeJson(source,`${prefix}/package.json`,{name:"lotus-plugin",version:"1.0.0"});
  const bytes=await put(source,`${prefix}/MihoyoBBSTools/config/42.yaml`,legacy);
  await put(source,`${prefix}/config/config.yaml`,{schedule:"5 3 * * *",permissionControl:{mode:"blacklist",blacklist:[]},
    neteasePartner:{enable:true,accounts:[{uid:"34",cookie:"MUSIC_U=fixture",qq:"42"}]}});
  await writeJson(target,"package.json",{name:"lotus-yunzai"});await writeJson(target,"plugins/.fixture",{});
  for(const args of [["init","-q"],["add","package.json","plugins/.fixture"],["-c","core.hooksPath=/dev/null","-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","commit.gpgsign=false","commit","-qm","fixture"]]){
    const git=Bun.spawnSync(["git",...args],{cwd:target});if(git.exitCode)throw Error(git.stderr.toString());
  }
  const result=await migrateInstallation(source,target);
  expect(result).toMatchObject({status:"published",profiles:{imported:1,firstGeneration:{sources:1,imported:1,deferredPush:1}}});
  const config=Bun.YAML.parse(await readFile(join(target,"config/global.yaml"),"utf8")) as any;
  expect(config.scheduler).toMatchObject({mode:"fixed",fixed_time:"03:05"});
  expect(config.netease_partner).toMatchObject({enable:true,schedule:"0 30 1 * * ? *"});
  expect(await createProfileStore(join(target,"data/users")).summary("42",1)).toMatchObject({enabled:true,loggedIn:true});
  expect((await new NeteasePartnerAccounts(join(target,"data/netease/accounts.yaml")).loadAccounts())[0]?.uid).toBe("34");
  expect(await readFile(join(source,`${prefix}/MihoyoBBSTools/config/42.yaml`),"utf8")).toBe(bytes);
  expect(await readFile(join(target,`backup/legacy-lotus-v1/${prefix}/MihoyoBBSTools/config/42.yaml`),"utf8")).toBe(bytes);
  expect(await migrateInstallation(source,target)).toMatchObject({status:"already-published"});
}));
