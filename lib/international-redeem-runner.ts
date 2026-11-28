import type { createProfileStore, Game } from '@lotus-yunzai/account';
import type { HoyoTransport } from '../packages/hoyo-client/credentials.ts';
import { openHoYoLabRedemption } from '../packages/hoyo-client/redeem-submit.ts';
import { readHoYoLabRedeemCodes } from '../packages/hoyo-client/hoyolab-redeem-codes.ts';
import { createManualRedeemLedger, redeemResultText, type PreviewProfile } from './redeem-code-runner.ts';
import { createTranslator } from '../packages/i18n/index.ts';
import catalog from '../i18n/zh-CN.json';
const $t=createTranslator('core',catalog.messages);
const labels:Record<Game,string>={gs:$t('lib.redeem-code-runner.text_d1597c51ed'),sr:$t('lib.redeem-code-runner.text_4548f2ad35'),zzz:$t('lib.redeem-code-runner.text_b1110352c9')};
type Profiles=Pick<ReturnType<typeof createProfileStore>,'listPreviewRedeemProfiles'|'internationalRedeemContext'|'previewRedeemSettings'>;

export function createInternationalRedeemRunner(profiles:Profiles,transport:HoyoTransport,options:{
 readonly journal:string;readonly signal:AbortSignal;
 readonly codes?:(game:Game,signal:AbortSignal)=>Promise<readonly string[]>;
 readonly notify:(profile:PreviewProfile,reply:string,signal:AbortSignal,verify:()=>Promise<void>)=>Promise<unknown>;
 readonly warn?:(game:Game)=>void;
}){
 const ledger=createManualRedeemLedger(options.journal),blocked=new Map<string,string>();
 let running:Promise<void>|undefined;
 async function scan(){
  const signal=options.signal;
  const list=await profiles.listPreviewRedeemProfiles(signal);
  for(const game of ['gs','sr','zzz'] as const){
   signal.throwIfAborted();
   const subscribers=[];
   for(const profile of list.filter(row=>row.games.includes(game))){
    const source=await profiles.internationalRedeemContext(profile.qq,profile.profileId,game).catch(()=>undefined);
    const key=`${profile.qq}:${profile.profileId}:${game}`;
    if(source&&(game==='gs'||source.activityCookie)&&blocked.get(key)!==source.revision)subscribers.push({profile,source,key});
   }
   if(!subscribers.length)continue;
   let codes:readonly string[];
   try{codes=await(options.codes?options.codes(game,signal):readHoYoLabRedeemCodes(game,transport,signal));}
   catch{if(signal.aborted)return;options.warn?.(game);continue;}
   if(!codes.length)continue;
   for(const {profile,source,key} of subscribers){
    const verify=async()=>{
     signal.throwIfAborted();
     const settings=await profiles.previewRedeemSettings(profile.qq,profile.profileId);
     const current=await profiles.internationalRedeemContext(profile.qq,profile.profileId,game);
     if(!settings.enabled||!settings.games.includes(game)||settings.revision!==source.revision||current?.revision!==source.revision)
      throw Error('international-redeem-profile-changed');
     signal.throwIfAborted();
    };
    try{
     await verify();
     const client=await openHoYoLabRedemption(source,game,transport,{signal,verifyProfile:verify,allowManualCaptcha:false});
     const selected=client.roles.filter(role=>role.uid===source.selectedUid);
     const choices=selected.length?selected:client.roles.length===1?client.roles:client.roles.filter(role=>role.chosen);
     if(choices.length!==1)continue;
     const role=choices[0]!,lines:string[]=[];
     for(const code of codes){
      let claim:Awaited<ReturnType<typeof ledger.claim>>;
      let result:Awaited<ReturnType<typeof client.submit>>;
      try{
       result=await client.submit(code,role,async()=>Boolean(claim=await ledger.claim(`hoyolab:${source.realm}:${source.accountId}`,game,role,code)));
      }catch(error){await claim?.release();throw error;}
      if(result==='duplicate')continue;
      if(result==='login-expired'){await claim?.release();blocked.set(key,source.revision);break;}
      await claim?.finish();
      lines.push(`${code}：${redeemResultText[result]}`);
      if(result==='blocked'||result==='unknown'){blocked.set(key,source.revision);break;}
     }
     if(lines.length){await verify();await options.notify(profile,$t('lib.redeem-code-manual.text_8b852ebfd3',{label:labels[game],id:profile.profileId,value3:lines.join('\n')}),signal,verify);}
    }catch{if(signal.aborted)return;options.warn?.(game);}
   }
  }
 }
 return{run(){if(options.signal.aborted)return Promise.resolve();return running??=scan().finally(()=>{running=undefined;});}};
}
