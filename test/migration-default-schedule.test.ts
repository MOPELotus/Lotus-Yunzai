import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { applyMigrationDefaultSchedule, migrationDefaultClocks } from "../lib/migration-default-schedule.ts";
import { projectLegacyMediaConfig } from "../lib/migration-media-config.ts";
import { readLocalConfig } from "../lib/config.ts";
import { parseAtlasUpdatePolicy } from "../plugins/atlas/update-policy.ts";

async function put(root: string, path: string, value: unknown) {
  await mkdir(join(root, path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(join(root, path), Bun.YAML.stringify(value), { mode: 0o600 });
}
async function fixture(run: (stage: string) => Promise<void>) {
  const stage = await mkdtemp(join(tmpdir(), "lotus-migration-new-clocks-"));
  try { await run(stage); } finally { await rm(stage, { recursive: true, force: true }); }
}

test("final migration policy replaces old clocks and keeps account-independent settings and explicit pauses", async () => fixture(async stage => {
  const bot = { update_time: 17, update_cron: ["0 7 3 * * *"], restart_cron: ["0 9 4 * * *"], log_level: "debug" };
  const partner = projectLegacyMediaConfig({}, [{ netease_partner: { enable: true, schedule: "0 15,30 0 * * * *",
    review: { mode: "codex", codex_command: "/fixture/bin/codex", model: "fixture-model", max_chars: 80 } } }]).config.netease_partner;
  const global = { scheduler: { enable: false, mode: "fixed", fixed_time: "07:17", plan_generate_cron: "0 7 19 * * *",
    random: { window_start: "06:00", window_end: "07:00", notify_before: false },
    late_registration: { enabled: false, window_start: "08:00", window_end: "08:30", notify: false } },
    atlas: { locale: "zh", auto_update: { enable: true, check_cron: "0 7 3 * * *", challenge_cron: "0 9 4 * * *" } },
    netease_partner: partner, permissions: { default_policy: "deny" }, daily_note_reminders: { cron: "0 9 * * * *" } };
  await put(stage, "config/config/bot.yaml", bot); await put(stage, "config/global.yaml", global);
  const botBefore = await readFile(join(stage,"config/config/bot.yaml"));const globalBefore = await readFile(join(stage,"config/global.yaml"));
  const report = await applyMigrationDefaultSchedule(stage);
  expect(report.version).toBe(1); expect(report.filesAdjusted).toBe(2); expect(report.clocks).toMatchObject({
    update:"0 30 0,12 * * *", characterGallery:"0 0 1,13 * * *", atlas:"0 30 1,13 * * *",
    teamGuides:"0 0 2,14 * * *", otherGuides:"0 0 5,17 * * *", partner:"0 30 1 * * ? *" });
  const root=pathToFileURL(stage+"/"); expect(await readLocalConfig(root,"bot")).toEqual({...bot,update_time:0,update_cron:migrationDefaultClocks.update});
  const next=await readLocalConfig(root,"global");expect(next.scheduler).toEqual(global.scheduler);expect(report.checkinPolicy).toBe("preserved");
  expect(next.netease_partner).toEqual({...partner as object,schedule:migrationDefaultClocks.partner});
  expect(next.permissions).toEqual(global.permissions);expect(next.daily_note_reminders).toEqual(global.daily_note_reminders);
  expect(parseAtlasUpdatePolicy(next.atlas).version.cron).toBe(migrationDefaultClocks.atlas);
  expect(parseAtlasUpdatePolicy(next.atlas).challenge.cron).toBe(migrationDefaultClocks.atlas);
  expect(await readFile(join(stage,"backup/migration-schedule/config/config/bot.yaml"))).toEqual(botBefore);
  expect(await readFile(join(stage,"backup/migration-schedule/config/global.yaml"))).toEqual(globalBefore);
  expect((await applyMigrationDefaultSchedule(stage)).filesAdjusted).toBe(0);
}));

test("modern and legacy config clocks cannot disagree after final policy", async () => fixture(async stage=>{
  await put(stage,"config/bot.yaml",{update_time:5,log_level:"info"});await put(stage,"config/config/bot.yaml",{update_cron:"0 4 3 * * *"});
  await put(stage,"config/global.yaml",{netease_partner:{enable:false,review:{mode:"codex"}}});
  await put(stage,"config/config/global.yaml",{netease_partner:{enable:true,schedule:"0 9 8 * * *"},atlas:{auto_update:{enable:false}}});
  const report=await applyMigrationDefaultSchedule(stage);expect(report.filesAdjusted).toBe(4);
  for(const path of ['config/bot.yaml','config/config/bot.yaml'])expect(Bun.YAML.parse(await readFile(join(stage,path),'utf8'))).toMatchObject({update_time:0,update_cron:migrationDefaultClocks.update});
  for(const path of ['config/global.yaml','config/config/global.yaml'])expect((Bun.YAML.parse(await readFile(join(stage,path),'utf8')) as {netease_partner:{schedule:string}}).netease_partner.schedule).toBe(migrationDefaultClocks.partner);
  expect((await readLocalConfig(pathToFileURL(stage+'/'),'global')).netease_partner).toMatchObject({enable:false});
}));

test("empty payload gets current defaults; rejected links and cancellation never touch foreign config", async () => fixture(async stage=>{
  await applyMigrationDefaultSchedule(stage);expect(await readLocalConfig(pathToFileURL(stage+'/'),'global')).not.toHaveProperty("atlas");expect(await readLocalConfig(pathToFileURL(stage+'/'),'global')).not.toHaveProperty("scheduler");
  const foreign=await mkdtemp(join(tmpdir(),'lotus-migration-clocks-outside-'));
  try{
    const linked=join(stage,'linked');await symlink(foreign,linked,'dir');await expect(applyMigrationDefaultSchedule(linked)).rejects.toThrow();
    const before=await readFile(join(stage,'config/global.yaml'));await expect(applyMigrationDefaultSchedule(stage,AbortSignal.abort())).rejects.toThrow();expect(await readFile(join(stage,'config/global.yaml'))).toEqual(before);
  }finally{await rm(foreign,{recursive:true,force:true})}
}));


test("migration keeps random/fixed modes, individual times and both already planned signing days byte-identical", async () => fixture(async stage => {
  const day="2026-11-25";
  const paths: Record<string,string>={
    "data/users/10001.yaml":"enabled: true\naccount: {stoken: fixture}\nschedule: {mode: fixed, fixed_time: '06:17', allow_random: false}\n",
    "data/schedules/2026-11-25.json":JSON.stringify({date:day,entries:[{qq:"10001",profileId:1,time:"06:17",mode:"fixed",done:true,gameWrites:{"genshin/100000001":"confirmed"}}]}),
    "data/schedules/2026-11-26.json":JSON.stringify({date:"2026-11-26",entries:[{qq:"10001",profileId:1,time:"08:42",mode:"random",done:false,notified:true}]})
  };
  for(const [path,bytes]of Object.entries(paths)){await mkdir(join(stage,path,".."),{recursive:true,mode:0o700});await writeFile(join(stage,path),bytes,{mode:0o600})}
  for(const mode of ["fixed","random"]){
    const scheduler={mode,fixed_time:"06:17",plan_generate_cron:"0 9 19 * * *",random:{window_start:"07:00",window_end:"09:00"},late_registration:{window_start:"22:00",window_end:"23:00"}};
    await put(stage,"config/global.yaml",{scheduler});
    // Each fixture policy is normally applied once to a fresh private stage.
    await rm(join(stage,"backup"),{recursive:true,force:true});
    await applyMigrationDefaultSchedule(stage);
    expect((await readLocalConfig(pathToFileURL(stage+"/"),"global")).scheduler).toEqual(scheduler);
    for(const [path,bytes]of Object.entries(paths))expect(await readFile(join(stage,path),"utf8")).toBe(bytes);
  }
}));
