import type { Game } from '@lotus-yunzai/account';
import type { HoyoTransport } from './credentials.ts';
import { HoyoRequestError } from './errors.ts';
import { readGameRecordPayload } from './game-record.ts';
import { isRedeemCode } from './redeem-submit.ts';
import { requestOfficialJson } from './redeem-preview/http.ts';

const gameIds: Record<Game, number> = {gs:2,sr:6,zzz:8};
const object=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;

/** Only HoYoLAB's public, currently published exchange groups; never domestic code feeds. */
export async function readHoYoLabRedeemCodes(game:Game,transport:HoyoTransport,signal?:AbortSignal):Promise<readonly string[]>{
 signal?.throwIfAborted();
 if(!Object.hasOwn(gameIds,game))throw new HoyoRequestError('invalid-input','hoyolab-code-game');
 const url=new URL('https://bbs-api-os.hoyolab.com/community/painter/wapi/circle/channel/guide/material');
 url.searchParams.set('game_id',String(gameIds[game]));
 const deadline=AbortSignal.any([AbortSignal.timeout(20000),...(signal?[signal]:[])]);
 const headers={Accept:'application/json','x-rpc-language':'en-us','x-rpc-client_type':'4'};
 let payload:Record<string,unknown>|undefined;
 try{
  const response=await transport(url,{method:'GET',headers,signal:deadline,redirect:'error',credentials:'omit',referrerPolicy:'no-referrer'});
  if(response.redirected||response.url&&response.url!==url.href){await response.body?.cancel();throw new HoyoRequestError('response','hoyolab-code-redirect');}
  if(!response.ok){await response.body?.cancel();throw new HoyoRequestError('http','hoyolab-code-http',response.status);}
  payload=await readGameRecordPayload(response,1024*1024,deadline);
 }catch(error){
  deadline.throwIfAborted();
  if(error instanceof HoyoRequestError&&(error.code!=='http'||(error.status??0)<500))throw error;
  // Anonymous public endpoint only: the native HTTPS path carries no account credentials.
  payload=object(await requestOfficialJson(url,{headers,timeoutMs:10000,signal:deadline}));
 }
 deadline.throwIfAborted();
 const data=object(payload?.data),modules=data?.modules;
 if(payload?.retcode!==0||!Array.isArray(modules)||modules.length>256)throw new HoyoRequestError('response','hoyolab-code-response');
 const codes=new Map<string,string>();
 for(const item of modules){
  const group=object(item)?.exchange_group;
  if(group==null)continue;
  const bonuses=object(group)?.bonuses;
  if(!Array.isArray(bonuses)||bonuses.length>256)throw new HoyoRequestError('response','hoyolab-code-group');
  for(const bonus of bonuses){
   const code=object(bonus)?.exchange_code;
   if(typeof code!=='string'||!isRedeemCode(code.trim()))throw new HoyoRequestError('response','hoyolab-code-format');
   if(!codes.has(code.trim().toLowerCase()))codes.set(code.trim().toLowerCase(),code.trim());
   if(codes.size>256)throw new HoyoRequestError('response','hoyolab-code-count');
  }
 }
 return [...codes.values()];
}
