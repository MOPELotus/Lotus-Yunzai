import {expect,test,mock} from 'bun:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProfileStore} from '@lotus-yunzai/account';
import type {ProfileCardModel} from '@lotus-yunzai/skia/profile';
const models:ProfileCardModel[]=[];
mock.module('@lotus-yunzai/skia/profile',()=>({openProfileCardTheme:async()=>{},renderProfileCard:async(model:ProfileCardModel)=>{models.push(model);return {png:Buffer.from([1])};}}));
const {selectOwnRole}=await import('../lib/own-role-selection.ts');
const old=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const current=Uint8Array.fromBase64('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR42mMU1TBjYGBgYmBgQFAACLwAebTfQhYAAAAASUVORK5CYII=');
for(const mode of ['current-and-old','missing-current','failed-current','no-old','unreadable-current'] as const){
 test(`own role avatar priority: ${mode}`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'lotus-role-avatar-'));const native=globalThis.fetch;let requested=0;
  const official=mode==='unreadable-current'?current.slice(0,33):current;
  try{
   await writeFile(join(root,'42.yaml'),Bun.YAML.stringify({user:{qq:'42'},account:{stuid:'42',stoken:'fixture',cookie:'ltuid=42;ltoken=fixture',game_roles:{gs:[{uid:'100000042',region:'cn_gf01',game_biz:'hk4e_cn',nickname:'fixture',...(mode==='missing-current'?{}:{game_head_icon:'https://upload-bbs.mihoyo.com/roles/current.png'})}]}}}));
   globalThis.fetch=Object.assign(async()=>{requested++;return mode==='failed-current'?new Response(null,{status:404}):new Response(official,{headers:{'content-type':'image/png'}});},{preconnect:native.preconnect}) as typeof fetch;
   const profiles=createProfileStore(root);models.length=0;
   const oldArtwork=mode==='no-old'?undefined:async()=>({image:old,banner:old});
   await selectOwnRole(profiles,{game:'gs'},{user:42,signal:new AbortController().signal,isCurrent:()=>true},oldArtwork);
   expect(models).toHaveLength(1);const row=models[0]!.roleGroups?.[0]?.rows?.[0];expect(row?.uid).toBe('100000042');
   if(mode==='missing-current'||mode==='failed-current')expect(row?.image).toEqual(old);
   else expect(row?.image).toEqual(official);
   expect(row?.banner).toEqual(mode==='no-old'?undefined:old);
   expect(row?.fallbackImage).toEqual(mode==='current-and-old'||mode==='unreadable-current'?old:undefined);
   expect(requested>0).toBe(mode!=='missing-current');
  }finally{globalThis.fetch=native;await rm(root,{recursive:true,force:true});}
 });
}
