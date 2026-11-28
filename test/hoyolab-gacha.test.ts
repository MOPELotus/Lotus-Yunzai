import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfileStore } from '../packages/account/index.ts';
import { createProfileHoyoClient } from '../packages/hoyo-client/index.ts';
import { readHoYoLabAuthKey } from '../packages/hoyo-client/hoyolab-authkey.ts';
import { createStarRailGachaRecordArchive } from '../plugins/starrail/gacha-record-archive.ts';
import { syncHoYoLabStarRailGacha, HoYoLabStarRailAuthKeyRejected } from '../plugins/starrail/hoyolab-gacha-sync.ts';
import { lockFile } from '../lib/file-lock.ts';
const credentials = { accountId:'4202',realm:'SG' as const,mid:'fixture-mid',stoken:'v2_fixture-stoken',deviceId:'fixture-device',cookie:'account_id_v2=4202; cookie_token_v2=fixture-cookie; account_mid_v2=fixture-mid',activityCookie:'ltuid_v2=4202; ltoken_v2=fixture-ltoken; ltmid_v2=fixture-mid' };
const roles = { gs:[{uid:'800000001',region:'os_asia',gameBiz:'hk4e_global',nickname:'',chosen:true}],sr:[{uid:'800000002',region:'prod_official_asia',gameBiz:'hkrpg_global',nickname:'',chosen:true}],zzz:[{uid:'1300000001',region:'prod_gf_jp',gameBiz:'nap_global',nickname:'',chosen:true}] };
async function fixture(){const root=await mkdtemp(join(tmpdir(),'lotus-hoyolab-gacha-'));const profiles=createProfileStore(join(root,'profiles'));await profiles.saveInternationalLogin(await profiles.openLoginSlot('42'),credentials,roles);return{root,profiles};}
test('HoYoLAB authorization retries connection failures, uses CookieToken only and decodes authkey once',async()=>{const f=await fixture();try{let calls=0;const source=await f.profiles.requestSelectedContext('42',1,'sr');const result=await readHoYoLabAuthKey(source,async(url,init)=>{expect(url.href).toBe('https://api-account-os.hoyoverse.com/binding/api/genAuthKeyByCookieToken');expect(new Headers(init.headers).get('Cookie')).toBe(credentials.cookie);expect(JSON.parse(String(init.body))).toMatchObject({game_uid:source.role.uid,region:'prod_official_asia',game_biz:'hkrpg_global'});if(++calls===1)throw Object.assign(new Error(),{code:'ECONNRESET'});return Response.json({retcode:0,data:{authkey:'fixture%2Bkey%3D'}});});expect(calls).toBe(2);expect(result.authkey).toBe('fixture+key=');}finally{await rm(f.root,{recursive:true,force:true});}});
test('Genshin overseas history uses the global history API and never sends its CookieToken to history requests',async()=>{const f=await fixture();try{const source=await f.profiles.requestSelectedContext('42',1,'gs');const hosts:string[]=[];const client=createProfileHoyoClient(f.profiles,async(url,init)=>{hosts.push(url.host);if(url.pathname.endsWith('genAuthKeyByCookieToken'))return Response.json({retcode:0,data:{authkey:'fixture-key'}});expect(url.hostname).toBe('public-operation-hk4e-sg.hoyoverse.com');expect(url.searchParams.get('game_biz')).toBe('hk4e_global');expect(new Headers(init.headers).has('Cookie')).toBe(false);return Response.json({retcode:0,data:{list:[]}});});const result=await client.fetchGenshinGacha(source,{intervalMs:0});expect(result.pools).toHaveLength(4);expect(hosts).toHaveLength(5);}finally{await rm(f.root,{recursive:true,force:true});}});
test('Star Rail overseas update imports all six pools through the raw archive, including collaboration paths, without fabricating miniapp history',async()=>{const f=await fixture();try{const source=await f.profiles.requestSelectedContext('42',1,'sr');const paths=new Set<string>();const transport=async(url:URL,init:RequestInit)=>{if(url.pathname.endsWith('genAuthKeyByCookieToken'))return Response.json({retcode:0,data:{authkey:'fixture-key'}});expect(new Headers(init.headers).has('Cookie')).toBe(false);expect(url.hostname).toBe('public-operation-hkrpg-sg.hoyoverse.com');paths.add(url.pathname);const pool=url.searchParams.get('gacha_type')!;return Response.json({retcode:0,data:{region_time_zone:8,list:url.searchParams.get('end_id')==='0'?[{uid:source.role.uid,id:String(10000+Number(pool)),gacha_id:'1001',gacha_type:pool,item_id:'1001',time:'2026-11-01 00:00:00',rank_type:pool==='11'?'5':'3',count:'1'}]:[]}});};const client=createProfileHoyoClient(f.profiles,transport);const archive=createStarRailGachaRecordArchive({directory:join(f.root,'raw'),legacyDirectory:join(f.root,'legacy')},lockFile);const first=await syncHoYoLabStarRailGacha(source,f.profiles,client,archive,{intervalMs:0},transport);expect(first.pools).toHaveLength(6);expect(first.added).toBe(1);expect(paths.has('/common/gacha_record/api/getLdGachaLog')).toBe(true);const again=await syncHoYoLabStarRailGacha(source,f.profiles,client,archive,{intervalMs:0},transport);expect(again.added).toBe(0);const stored=await archive.read({qq:'42',uid:source.role.uid},{legacyTimezone:8});expect(stored.status==='available'&&stored.archive.records.length).toBe(6);}finally{await rm(f.root,{recursive:true,force:true});}});
test('unadapted overseas functions stop before any domestic request',async()=>{const f=await fixture();try{const source=await f.profiles.requestSelectedContext('42',1,'sr');let calls=0;const client=createProfileHoyoClient(f.profiles,async()=>{calls++;throw Error('must not send');});expect(()=>client.fetchStarRailOnline(source)).toThrow('国际服暂不支持此功能');expect(calls).toBe(0);}finally{await rm(f.root,{recursive:true,force:true});}});

test('Genshin overseas native sync archives US server timestamps in the existing UTC+8 clock',async()=>{const f=await fixture();try{
 const {createGenshinGachaSync}=await import('../plugins/genshin/gacha-sync.ts');const{createGenshinGachaHistoryStore}=await import('../plugins/genshin/gacha-store.ts');const before=await f.profiles.roleCatalog('42',1);
 await f.profiles.saveInternationalRoles('42',1,before.revision,{...roles,gs:[{...roles.gs[0]!,uid:'600000001',region:'os_usa'}]});
 const client=createProfileHoyoClient(f.profiles,async(url)=>{if(url.pathname.endsWith('genAuthKeyByCookieToken'))return Response.json({retcode:0,data:{authkey:'fixture-key'}});const type=url.searchParams.get('gacha_type');return Response.json({retcode:0,data:{region:'os_usa',list:type==='301'&&url.searchParams.get('end_id')==='0'?[{uid:'600000001',id:'100000000000000001',gacha_type:'301',item_id:'11301',name:'fixture',item_type:'武器',rank_type:'3',time:'2026-11-27 18:00:00',count:'1'}]:[]}});});
 const result=await createGenshinGachaSync(f.profiles,client,createGenshinGachaHistoryStore(join(f.root,'gs-history'),lockFile)).sync('42',1,{intervalMs:0});
 expect(result.uid).toBe('600000001');expect(result.records[301][0]?.time).toBe('2026-11-28 07:00:00');
 const{exportGenshinUigf,selectGenshinUigf}=await import('../plugins/genshin/gacha-uigf.ts');const resolveItem=()=>({itemId:'11301',name:'fixture',itemType:'武器' as const,rank:3 as const});const doc=exportGenshinUigf(result.records,{uid:result.uid,exportedAt:new Date('2026-11-28T00:00:00Z'),app:{name:'fixture',version:'1'},resolveItem});const imported=selectGenshinUigf(doc,{uid:result.uid,resolveItem});expect(imported.region).toBe('os_usa');expect(imported.pools[0]?.records[0]?.time).toBe('2026-11-28 07:00:00');
}finally{await rm(f.root,{recursive:true,force:true});}});

test('HoYoLAB authorization rejects unsupported key versions or signing modes before the record request',async()=>{
 const f=await fixture();try{
  const source=await f.profiles.requestSelectedContext('42',1,'sr');
  for(const metadata of [{authkey_ver:2},{authkey_ver:'2'},{sign_type:1},{sign_type:'1'},{authkey_ver:{}},{sign_type:null}]){
   let calls=0;
   const transport=async()=>{calls++;return Response.json({retcode:0,data:{authkey:'fixture-key',...metadata}})};
   await expect(readHoYoLabAuthKey(source,transport)).rejects.toThrow();expect(calls).toBe(1);
  }
  const result=await readHoYoLabAuthKey(source,async()=>Response.json({retcode:0,data:{authkey:'fixture-key',authkey_ver:'1',sign_type:'2'}}));
  expect(result.authkey).toBe('fixture-key');
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('Star Rail successful authorization followed by rejected authkey preserves existing gacha history',async()=>{
 const f=await fixture();try{
  const source=await f.profiles.requestSelectedContext('42',1,'sr');let recordRequests=0;
  const transport=async(url:URL)=>{
   if(url.pathname.endsWith('genAuthKeyByCookieToken'))return Response.json({retcode:0,data:{authkey:'fixture-key',authkey_ver:1,sign_type:2}});
   recordRequests++;return Response.json({retcode:-100,message:'authkey error',data:null});
  };
  const client=createProfileHoyoClient(f.profiles,transport);
  const archive=createStarRailGachaRecordArchive({directory:join(f.root,'raw'),legacyDirectory:join(f.root,'legacy')},lockFile);
  await archive.merge({qq:'42',uid:source.role.uid},{uid:source.role.uid,timezone:8,records:[{uid:source.role.uid,id:'100000000000000001',gacha_id:'1001',gacha_type:'11',item_id:'1001',time:'2026-11-01 00:00:00',rank_type:'5',count:'1',name:'fixture',item_type:'角色'}]},async()=>{}, {legacyTimezone:8});
  const before=await archive.read({qq:'42',uid:source.role.uid},{legacyTimezone:8});
  await expect(syncHoYoLabStarRailGacha(source,f.profiles,client,archive,{intervalMs:0},transport)).rejects.toBeInstanceOf(HoYoLabStarRailAuthKeyRejected);
  expect(recordRequests).toBe(1);
  expect(await archive.read({qq:'42',uid:source.role.uid},{legacyTimezone:8})).toEqual(before);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
