import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { migrateInstallation } from "../scripts/migrate.ts";
import { generateCheckinSchedulePlan } from "../lib/checkin-schedule-plan.ts";
import { readLocalConfig } from "../lib/config.ts";

test.skipIf(!Bun.which("git"))("full install applies maintenance clocks and CLI settings while keeping settled signing plans", async () => {
  const parent=await mkdtemp(join(tmpdir(),"lotus-migration-policy-install-"));const source=join(parent,"old"),target=join(parent,"new");
  async function put(base:string,path:string,text:string){await mkdir(dirname(join(base,path)),{recursive:true,mode:0o700});await writeFile(join(base,path),text,{mode:0o600})}
  const at=Date.parse("2026-11-25T12:00:00+08:00"), profiles=[{qq:"42",profileId:1,enabled:true}];
  const initialToday=generateCheckinSchedulePlan({now:at,date:"2026-11-25",profiles,config:{mode:"fixed",fixed_time:"06:17"}});
  const today={...initialToday,entries:initialToday.entries.map(entry=>({...entry,done:true}))};
  const initialTomorrow=generateCheckinSchedulePlan({now:at,date:"2026-11-26",profiles,config:{mode:"random"},random:()=>.42});
  const tomorrow={...initialTomorrow,entries:initialTomorrow.entries.map(entry=>({...entry,notified:true}))};
  const scheduler={mode:"fixed",fixed_time:"06:17",plan_generate_cron:"0 9 19 * * *",random:{window_start:"07:00",window_end:"09:00"}};
  const originals={
    "config/config/bot.yaml":Bun.YAML.stringify({update_time:17,update_cron:"0 7 3 * * *",log_level:"info"}),
    "plugins/Lotus-Plugin/config/global.yaml":Bun.YAML.stringify({scheduler,netease_partner:{enable:true,schedule:"0 15,30 0 * * * *",review:{mode:"codex",codex_command:"codex",model:"fixture-model",max_chars:80}}}),
    "plugins/Lotus-Plugin/data/users/42.yaml":Bun.YAML.stringify({enabled:true,user:{qq:"42"},profile:{id:1},account:{stuid:"1024",cookie:"account_id=1024;cookie_token=fixture"},schedule:{mode:"fixed",fixed_time:"06:17",allow_random:false}}),
    "plugins/Lotus-Plugin/data/schedules/2026-11-25.json":JSON.stringify(today),
    "plugins/Lotus-Plugin/data/schedules/2026-11-26.json":JSON.stringify(tomorrow),
  };
  try{
    for(const [p,text]of Object.entries(originals))await put(source,p,text);
    await put(target,"package.json",'{"name":"lotus-yunzai"}');await put(target,"plugins/genshin/module.ts","export default {};\n");
    for(const args of [["init"],["add","."],["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","fixture"]])expect(Bun.spawnSync(["git",...args],{cwd:target,stdout:"ignore",stderr:"ignore"}).exitCode).toBe(0);
    const report=await migrateInstallation(source,target);
    expect(report.schedulePolicy).toMatchObject({version:1,checkinPolicy:"preserved"});
    const root=pathToFileURL(target+"/");const bot=await readLocalConfig(root,"bot"),global=await readLocalConfig(root,"global");
    expect(bot).toMatchObject({update_time:0,update_cron:"0 30 0,12 * * *"});expect(global.scheduler).toEqual(scheduler);
    expect(global.netease_partner).toMatchObject({enable:true,schedule:"0 30 1 * * ? *",review:{mode:"codex",codex_command:"codex",model:"fixture-model",max_chars:80}});
    const user=Bun.YAML.parse(await readFile(join(target,"data/users/42.yaml"),"utf8"));expect(user).toMatchObject({schedule:{mode:"fixed",fixed_time:"06:17",allow_random:false}});
    for(const plan of [today,tomorrow]){const {importedLegacy,...migrated}=JSON.parse(await readFile(join(target,"data/schedules",plan.date+".json"),"utf8"));expect(migrated).toEqual(plan);expect(importedLegacy).toEqual(["Lotus-Plugin"])}
    for(const [p,text]of Object.entries(originals))expect(await readFile(join(source,p),"utf8")).toBe(text);
    expect((await migrateInstallation(source,target)).status).toBe("already-published");
    const metadata=join(parent,".new.lotus-migration-prepared/plan.json");const stale=JSON.parse(await readFile(metadata,"utf8"));
    const currentMetadata=JSON.stringify(stale);delete stale.conversionVersion;await writeFile(metadata,JSON.stringify(stale),{mode:0o600});
    await expect(migrateInstallation(source,target)).rejects.toThrow("旧转换规则");
    expect((await readLocalConfig(root,"global")).scheduler).toEqual(scheduler);
    const oldSchedule=JSON.parse(currentMetadata);delete oldSchedule.report.schedulePolicy;await writeFile(metadata,JSON.stringify(oldSchedule),{mode:0o600});
    await expect(migrateInstallation(source,target)).rejects.toThrow("旧日程策略");
    expect((await readLocalConfig(root,"global")).scheduler).toEqual(scheduler);
  }finally{await rm(parent,{recursive:true,force:true})}
},60_000);
