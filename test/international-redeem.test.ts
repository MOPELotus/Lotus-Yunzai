import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfileStore } from '../packages/account/index.ts';
import { openHoYoLabRedemption } from '../packages/hoyo-client/redeem-submit.ts';
import { readHoYoLabRedeemCodes } from '../packages/hoyo-client/hoyolab-redeem-codes.ts';
import { createInternationalRedeemRunner } from '../lib/international-redeem-runner.ts';
import type { HoyoTransport } from '../packages/hoyo-client/credentials.ts';

const source={accountId:'4202',realm:'SG' as const,language:'zh-cn',cookie:'account_id_v2=4202; cookie_token_v2=fixture-cookie; account_mid_v2=fixture-mid',activityCookie:'ltuid_v2=4202; ltoken_v2=fixture-ltoken; ltmid_v2=fixture-mid'};
const roles={gs:{uid:'800000001',region:'os_asia',biz:'hk4e_global'},sr:{uid:'800000002',region:'prod_official_asia',biz:'hkrpg_global'},zzz:{uid:'100000081',region:'prod_gf_jp',biz:'nap_global'}};
const ok=(data:unknown)=>Response.json({retcode:0,data});

test('published overseas code feed carries no credentials and deduplicates official groups',async()=>{
 const codes=await readHoYoLabRedeemCodes('zzz',async(url,init)=>{
  expect(url.hostname).toBe('bbs-api-os.hoyolab.com');expect(url.searchParams.get('game_id')).toBe('8');
  expect(new Headers(init.headers).has('Cookie')).toBe(false);expect(init.redirect).toBe('error');
  return ok({modules:[{exchange_group:null},{exchange_group:{bonuses:[{exchange_code:'GLOBAL-1'},{exchange_code:'global-1'}]}}]});
 });expect(codes).toEqual(['GLOBAL-1']);
 for(const data of [{modules:[{exchange_group:{}}]},{modules:[{exchange_group:{bonuses:[{exchange_code:'invalid code'}]}}]},{}]){
  await expect(readHoYoLabRedeemCodes('gs',async()=>ok(data))).rejects.toThrow();
 }
 expect(await readHoYoLabRedeemCodes('gs',async()=>ok({modules:[]}))).toEqual([]);
});

test('three overseas redemptions use the official method, credential family and selected owned role',async()=>{
 for(const game of ['gs','sr','zzz'] as const){
  let writes=0,reserved=false;
  const role=roles[game];
  const transport:HoyoTransport=async(url,init)=>{
   if(url.hostname==='api-account-os.hoyolab.com'){
    expect(url.pathname).toContain(game==='gs'?'CookieToken':'Ltoken');
    expect(new Headers(init.headers).get('Cookie')).toBe(game==='gs'?source.cookie:source.activityCookie);
    return ok({list:[{game_uid:role.uid,region:role.region,game_biz:role.biz,is_chosen:true}]});
   }
   expect(reserved).toBe(true);writes++;
   expect(url.hostname).toBe(`public-operation-${game==='gs'?'hk4e':game==='sr'?'hkrpg':'nap'}.hoyoverse.com`);
   expect(init.method).toBe(game==='gs'?'GET':'POST');
   const fields=game==='gs'?Object.fromEntries(url.searchParams):JSON.parse(String(init.body));
   expect(fields.uid).toBe(game==='gs'?role.uid:Number(role.uid));expect(fields.region).toBe(role.region);expect(fields.game_biz).toBe(role.biz);
   expect(new Headers(init.headers).get('Cookie')).toBe(source.cookie);
   if(game!=='gs'){expect(fields.platform).toBe('4');expect(fields.device_uuid).toMatch(/^[0-9a-f-]{36}$/);expect(fields.t).toBeLessThan(10_000_000_000);}
   return Response.json({retcode:-2017});
  };
  const client=await openHoYoLabRedemption(source,game,transport,{verifyProfile:async()=>{}});
  expect(await client.submit('GLOBAL-1',role,async()=>{reserved=true;return true})).toBe('already-used');expect(writes).toBe(1);
  await expect(client.submit('GLOBAL-2',{...role,uid:'100000099'},async()=>true)).rejects.toThrow();expect(writes).toBe(1);
 }
});

async function fixture(use:(path:string,profiles:ReturnType<typeof createProfileStore>)=>Promise<void>){
 const path=await mkdtemp(join(tmpdir(),'lotus-os-redeem-'));
 try{
  await writeFile(join(path,'42.yaml'),Bun.YAML.stringify({version:1,enabled:false,user:{qq:'42'},profile:{id:1},auto_redeem:{enable:true,games:['zzz'],local_enrollment:true},games:{os:{enable:false,cookie:source.cookie,verified_activity_cookie:source.activityCookie,verified_account_id:source.accountId,verified_realm:source.realm,current_uid:{zzz:roles.zzz.uid}}}}));
  await use(path,createProfileStore(path));
 }finally{await rm(path,{recursive:true,force:true});}
}
const roleReply=()=>ok({list:[{game_uid:roles.zzz.uid,region:roles.zzz.region,game_biz:roles.zzz.biz,is_chosen:true}]});

test('automatic overseas redemption honors registration and persists per-code reservations across restart',async()=>fixture(async(path,profiles)=>{
 let writes=0,notices=0,lookups=0;
 const transport:HoyoTransport=async(url)=>{if(url.hostname==='api-account-os.hoyolab.com')return roleReply();writes++;return ok({});};
 const options={journal:join(path,'auto.json'),signal:new AbortController().signal,codes:async()=>{lookups++;return ['GLOBAL-1']},notify:async()=>{notices++}};
 await createInternationalRedeemRunner(profiles,transport,options).run();
 await createInternationalRedeemRunner(profiles,transport,options).run();
 expect(writes).toBe(1);expect(notices).toBe(1);expect(lookups).toBe(2);
 const journal=await readFile(options.journal,'utf8');expect(journal).not.toContain('4202');expect(journal).not.toContain('GLOBAL-1');
 const before=await profiles.previewRedeemSettings('42',1);await profiles.setPreviewRedeemSettings('42',1,before.revision,false);
 await createInternationalRedeemRunner(profiles,transport,options).run();expect(lookups).toBe(2);
}));

test('uncertain dispatch is not replayed, and a disabled registration cannot dispatch',async()=>fixture(async(path,profiles)=>{
 let writes=0;
 const transport:HoyoTransport=async(url)=>{if(url.hostname==='api-account-os.hoyolab.com')return roleReply();writes++;throw new TypeError('connection lost after submit');};
 const options={journal:join(path,'auto.json'),signal:new AbortController().signal,codes:async()=>['GLOBAL-1'],notify:async()=>{}};
 const runner=createInternationalRedeemRunner(profiles,transport,options);await runner.run();await runner.run();
 await createInternationalRedeemRunner(profiles,transport,options).run();expect(writes).toBe(1);
}));

test('credential/registration changes during official lookup stop all submissions',async()=>fixture(async(path,profiles)=>{
 let writes=0;
 const runner=createInternationalRedeemRunner(profiles,async()=>{writes++;return roleReply()},{journal:join(path,'auto.json'),signal:new AbortController().signal,codes:async()=>{const saved=await profiles.previewRedeemSettings('42',1);await profiles.setPreviewRedeemSettings('42',1,saved.revision,false);return ['GLOBAL-1']},notify:async()=>{throw Error('must not notify')}});
 await runner.run();expect(writes).toBe(0);
}));
