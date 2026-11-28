import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hoyoLabProfileCommands, isHoYoLabCookieInput } from '../lib/hoyolab-profile-commands.ts';
import type { MessageFallbackContext } from '../lib/commands.ts';
import type { HoyoTransport } from '../packages/hoyo-client/credentials.ts';

const message='#绑定国际服SToken2 stuid=4202; stoken=v2_fixture-stoken; mid=fixture-mid; ma_passport_region=SG';
const context=(msg=message,fields:Partial<MessageFallbackContext>={}):MessageFallbackContext=>({normalizedMessage:msg,message_type:'private',self_id:99,user_id:42,isMaster:false,isBotMaster:()=>false,reply:()=>true,privateCredentialSignal:new AbortController().signal,...fields});
function transport(onRequest?:()=>Promise<void>):HoyoTransport{return async(url)=>{
 await onRequest?.();
 expect(url.hostname.endsWith('hoyolab.com')||url.hostname.endsWith('hoyoverse.com')).toBe(true);
 if(url.pathname.endsWith('getBySToken'))return Response.json({retcode:0,data:{tokens:[{token_type:2,token:'fixture-ltoken'},{token_type:4,token:'fixture-cookie'}]}});
 if(/verifyCookieToken|verifyLToken/u.test(url.pathname))return Response.json({retcode:0,data:{user_info:{aid:'4202',mid:'fixture-mid'}}});
 if(url.pathname.includes('getUserGameRoles'))return Response.json({retcode:0,data:{list:url.searchParams.get('game_biz')==='hk4e_global'?[{game_uid:'800000001',region:'os_asia',game_biz:'hk4e_global',is_chosen:true}]:[]}});
 throw Error('unexpected request');
};}

test('SToken import can create an overseas-only slot without modifying a domestic sibling',async()=>{
 const path=await mkdtemp(join(tmpdir(),'lotus-os-import-'));
 try{
  const sibling=join(path,'42.yaml');await writeFile(sibling,'version: 1\nuser: {qq: "42"}\nprofile: {id: 1}\naccount: {cookie: domestic-fixture}\n');const original=await readFile(sibling,'utf8');
  const module=hoyoLabProfileCommands(path,new AbortController().signal,{transport:transport(),viewProfile:id=>`profile-${id}`});
  expect(await module.fallback?.(message,context())).toBe('profile-2');
  const saved=Bun.YAML.parse(await readFile(join(path,'42-2.yaml'),'utf8')) as {games:{os:{enable:boolean;genshin:{checkin:boolean};verified_account_id:string;stoken:string;game_roles:{gs:{uid:string}[]}}};account?:unknown};
  expect(saved.games.os.verified_account_id).toBe('4202');expect(saved.games.os.stoken).toBe('v2_fixture-stoken');expect(saved.games.os.game_roles.gs[0]!.uid).toBe('800000001');
  expect(saved.account).toBeUndefined();expect(await readFile(sibling,'utf8')).toBe(original);
  saved.games.os.enable=false;saved.games.os.genshin.checkin=false;await writeFile(join(path,'42-2.yaml'),Bun.YAML.stringify(saved));
  await module.fallback?.(message,context());const again=Bun.YAML.parse(await readFile(join(path,'42-2.yaml'),'utf8')) as typeof saved;expect(again.games.os.enable).toBe(false);expect(again.games.os.genshin.checkin).toBe(false);
 }finally{await rm(path,{recursive:true,force:true});}
});

test('raw SToken messages use the secret-input route; group/delegated/malformed input never sends credentials',async()=>{
 let calls=0;const module=hoyoLabProfileCommands('/does-not-exist',new AbortController().signal,{transport:async()=>{calls++;throw Error('must not request')},viewProfile:()=>''});
 for(const input of [message,message.replace('绑定','导入'),message.replace('国际服','海外服')])expect(isHoYoLabCookieInput(input)).toBe(true);
 for(const [msg,fields] of [[message,{message_type:'group'}],[message,{isDelegated:true}],[message,{privateCredentialSignal:undefined}],[message.replace('4202','4202; account_id=999'),{}],[message.replace('mid=fixture-mid;',''),{}],[message.replace('SToken2','SToken02'),{}]] as const){
  const reply=await module.fallback?.(msg,context(msg,fields as Partial<MessageFallbackContext>));expect(typeof reply).toBe('string');expect(String(reply)).not.toContain('v2_fixture-stoken');
 }
 expect(calls).toBe(0);
});

test('profile revisions are rechecked before saving verified imported tokens',async()=>{
 const path=await mkdtemp(join(tmpdir(),'lotus-os-import-race-'));let replaced=false;
 try{
  const target=join(path,'42-2.yaml');
  const module=hoyoLabProfileCommands(path,new AbortController().signal,{transport:transport(async()=>{if(!replaced){replaced=true;await writeFile(target,'version: 1\nuser: {qq: "42"}\nprofile: {id: 2}\naccount: {cookie: new-domestic}\n')}}),viewProfile:()=>{throw Error('must not display stale tokens')}});
  await module.fallback?.(message,context());
  const saved=await readFile(target,'utf8');expect(saved).toContain('new-domestic');expect(saved).not.toContain('fixture-stoken');
 }finally{await rm(path,{recursive:true,force:true});}
});
