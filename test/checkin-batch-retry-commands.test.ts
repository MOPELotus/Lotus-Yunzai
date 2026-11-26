import { expect, test } from 'bun:test';
import { checkinBatchRetryCommands } from '../lib/checkin-batch-retry-commands.ts';
import type { MessageFallbackContext } from '../lib/commands.ts';
type Options=Parameters<typeof checkinBatchRetryCommands>[0];
const context={message_type:'group',group_id:700,self_id:12,user_id:51,isMaster:true,isBotMaster:()=>true,normalizedMessage:'#全部补签',reply:()=>true} as const satisfies MessageFallbackContext;
function fixture(){
 const trace:string[]=[];
 const profiles={listCheckinProfiles:async()=>{trace.push('list');return[{qq:'a',profileId:1},{qq:'b',profileId:1},{qq:'c',profileId:1},{qq:'c',profileId:1},{qq:'d',profileId:2}]},checkinSettings:async(qq:string)=>({enabled:qq!=='b',revision:'r'})} as unknown as Options['profiles'];
 const options:Options={profiles,signal:new AbortController().signal,now:()=>Date.parse('2026-11-27T12:00:00+08:00'),completedToday:async qq=>qq==='a',run:async(qq,_id,input)=>{await input.verifySession();trace.push('run '+qq);return qq==='d'?{status:'busy'}:{status:'complete',ok:true,reply:'receipt',revision:'r'}},deliver:async qq=>{trace.push('deliver '+qq)}};
 return{options,trace};
}
test('batch retry denies ordinary users before reading any accounts',async()=>{
 const {options,trace}=fixture();const command=checkinBatchRetryCommands(options);
 expect(await command.fallback?.('#全部补签',{...context,isMaster:false,isBotMaster:()=>false})).toContain('仅主人');expect(trace).toEqual([]);
});
test('batch retry filters disabled/completed profiles and duplicates, keeps receipts personal',async()=>{
 const {options,trace}=fixture();const command=checkinBatchRetryCommands(options);
 const summary=await command.fallback?.('#全部补签',context);
 expect(trace).toEqual(['list','run c','deliver c','run d']);expect(summary).toContain('共 3 个档案');expect(summary).toContain('本次成功 1');expect(summary).toContain('执行中跳过 1');expect(String(summary)).not.toContain('receipt');
});
test('notification failure does not retry writes and overlapping batches are refused',async()=>{
 const {options,trace}=fixture(),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();
 options.run=async(qq,_id,input)=>{await input.verifySession();trace.push('run '+qq);if(qq==='c'){entered.resolve();await finish.promise;}return{status:'complete',ok:true,reply:'receipt',revision:'r'}};
 options.deliver=async()=>{throw Error('synthetic transport failure')};
 const command=checkinBatchRetryCommands(options),pending=command.fallback?.('#全部补签',context);await entered.promise;
 expect(await command.fallback?.('#全部补签',context)).toContain('已有批量补签');finish.resolve();const summary=await pending;
 expect(trace.filter(x=>x==='run c')).toHaveLength(1);expect(summary).toContain('通知失败 2');expect(summary).toContain('本次成功 2');
});
test('batch retry stops when the day changes and never starts another target',async()=>{
 const {options,trace}=fixture();let now=Date.parse('2026-11-27T23:59:59+08:00');options.now=()=>now;options.run=async(qq)=>{trace.push('run '+qq);now+=2000;return{status:'complete',ok:true}};
 const summary=await checkinBatchRetryCommands(options).fallback?.('#全部补签',context);expect(trace).toEqual(['list','run c']);expect(summary).toContain('已中止');expect(summary).toContain('本次成功 1');
});
