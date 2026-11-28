import {test,expect} from 'bun:test';
import {createModule} from '../plugins/zzz/index.ts';
import {lockFile} from '../lib/file-lock.ts';
test('ZZZ registers all pool record aliases and profile suffixes',async()=>{
 const {fallbackFeatures,fallback}=createModule({signal:new AbortController().signal,lockFile});
 for(const command of ['抽卡','全部','角色','代理人','武器','音擎','常驻','邦布','角色回响','音擎回响','武器回响']){
  for(const normalizedMessage of [`%${command}记录2`,`#绝区零${command}记录2`]){
   const context={normalizedMessage,reply(){}};
   expect(await fallbackFeatures(context)).toEqual(['[gacha] 抽卡记录']);
   expect(await fallback(normalizedMessage,context)).toBeString();
  }
 }
});
