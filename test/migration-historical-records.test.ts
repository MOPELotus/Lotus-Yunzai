import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stageLegacyGameData } from '../lib/migration-game-data.ts';
import { createGenshinMonthlyArchive } from '../plugins/genshin/monthly-archive.ts';
import { createChallengeRankStore } from '../plugins/zzz/challenge-rank-store.ts';
import { lockFile } from '../lib/file-lock.ts';

async function fixture(run: (source: string, stage: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'lotus-migration-history-'));
  try { const source=join(root,'source'), stage=join(root,'stage'); await mkdir(source); await mkdir(stage,{mode:0o700}); await run(source,stage); }
  finally { await rm(root,{recursive:true,force:true}); }
}
async function put(root:string,path:string,value:unknown) { const file=join(root,path); await mkdir(dirname(file),{recursive:true}); const bytes=JSON.stringify(value,null,2)+'\n'; await writeFile(file,bytes); return bytes; }

test('迁移保留历史札记逐月数据，现有札记读取器直接读取全部年份',()=>fixture(async(source,stage)=>{
  const identity={qq:'42',accountId:'8080',uid:'500000003',region:'cn_qd01'};
  const raw=(month:number,count:number)=>({bind_uid:identity.uid,bind_region:identity.region,data_month:month,isUpdate:true,
    month_data:{current_primogems:count,current_mora:0,last_primogems:0,last_mora:0,group_by:[]}});
  const path=`data/NoteData/${identity.uid}.json`;
  const bytes=await put(source,path,{2024:{1:raw(1,0)},2025:{12:raw(12,123)},2026:{10:raw(10,456)}});
  const report=await stageLegacyGameData(source,stage);
  expect(report.active).toContainEqual({path:'data/NoteData',files:1,bytes:Buffer.byteLength(bytes)});
  expect(await readFile(join(stage,path),'utf8')).toBe(bytes);
  expect(await readFile(join(source,path),'utf8')).toBe(bytes);
  const archive=createGenshinMonthlyArchive(join(stage,'data/genshin/monthly'),join(stage,'data/NoteData'),lockFile);
  expect((await archive.read(identity)).map(row=>[row.year,row.snapshot.month,row.snapshot.primogems,row.finalized]))
    .toEqual([[2026,10,456,true],[2025,12,123,true],[2024,1,0,true]]);
  expect((await stat(join(stage,path))).mode&0o777).toBe(0o600);
}));

test('绝区零挑战原件不遗漏，现有旧群榜读取器可读取迁移的危局记录',()=>fixture(async(source,stage)=>{
  const uid='12345678',qq='42',group='77';
  const start={year:2026,month:11,day:20,hour:4,minute:0,second:0};
  const end={...start,day:30};
  const data={player:{player:{game_uid:uid,region:'prod_gf_cn',game_biz:'nap_cn',nickname:'合成绳匠'}},
    result:{has_data:true,start_time:start,end_time:end,total_score:150000,total_star:9,list:[{score:150000}]},updateTime:1795500000};
  const originals=new Map<string,string>();
  for(const folder of ['abyss','deadly','holoBoss','voidFrontBattle','climbingTower']){
    const path=`data/ZZZ-Plugin/${folder}/${uid}.json`; originals.set(path,await put(source,path,data));
  }
  const report=await stageLegacyGameData(source,stage);
  expect(report.active.length).toBe(5);
  for(const [path,bytes] of originals){ expect(await readFile(join(stage,path),'utf8')).toBe(bytes); expect(await readFile(join(source,path),'utf8')).toBe(bytes); }
  // Read through the production reader, with only the original registration/status keys present.
  const oldMember=`ZZZ:RANK:UID2QQS:${group}:${uid}:${qq}`;
  const redis={get:async(key:string)=>key===oldMember||key===`ZZZ:RANK:DEADLY:${group}:${uid}`?'1':null,
    hGetAll:async()=>({}),async *scanIterator(){yield oldMember;}};
  const store=createChallengeRankStore(redis as unknown as NonNullable<typeof globalThis.redis>,join(stage,'data/ZZZ-Plugin'));
  const rows=await store.rows(group,'DEADLY',new Set([qq]),Date.parse('2026-11-24T00:00:00+08:00'));
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({uid,qq,score:150000,source:'legacy'});
}));

test('损坏的历史札记不能被当作有效迁移成功',()=>fixture(async(source,stage)=>{
  await put(source,'data/NoteData/500000003.json',[]);
  await expect(stageLegacyGameData(source,stage)).rejects.toThrow();
}));
