import { expect, test } from 'bun:test';
import { getImageFooter, setImageFooter, parseImageFooter, layoutImageFooter } from './custom-footer.ts';
import type { CanvasRenderingContext2D } from 'skia-canvas';
import { footerMarkup } from './footer-markup.ts';

test('footer config is bounded, plain text, strict, and isolated from caller mutation',()=>{
 const defaults=parseImageFooter(undefined)!;
 expect(defaults.text).toBe('');
 expect(defaults.color).toBe('auto');
 expect('background' in defaults).toBe(false);
 expect('background' in parseImageFooter({text:'fixture',background:'#18233b'})!).toBe(false);
 for(const value of [{unknown:1},{text:'x'.repeat(2001)},{text:'\n'.repeat(20)},{text:'a\u0000'},{color:'url(x)'},{background:'transparent'},{fontSize:7},{fontSize:33},{lineHeight:2},{padding:-1},{align:'top'},{bold:1}])expect(parseImageFooter(value)).toBeUndefined();
 expect(parseImageFooter({text:'a\r\nb\t🐱'})?.text).toBe('a\nb\t🐱');
 const config={...defaults,text:'fixture'};setImageFooter(config);config.text='changed';const copy=getImageFooter();copy.text='changed';expect(getImageFooter().text).toBe('fixture');setImageFooter(undefined);
});

test('legacy footer spans retain nested emphasis without executing HTML or loading resources',()=>{
 const base={fontSize:14,bold:false,color:'auto'};
 const runs=footerMarkup('<span style="font-weight:bold;font-size:larger;color:#00BFFF">群 <span style="font-size:x-large;color:#ff3030">123</span></span><br>&lt;尾&gt;<span style="color:url(secret);font-size:999px">限</span>',base)!;
 expect(runs.map(run=>run.text).join('')).toBe('群 123\n<尾>限');
 expect(runs[0]).toMatchObject({fontSize:16.8,bold:true,color:'#00bfff'});
 expect(runs[1]).toMatchObject({fontSize:24,bold:true,color:'#ff3030'});
 expect(runs.at(-1)).toMatchObject({fontSize:32,color:'auto',bold:false});
 expect(footerMarkup('普通文本 < 30',base)).toBeUndefined();
 expect(footerMarkup('<b><img src="https://invalid">文本</b>',base)?.[0]?.text).toContain('<img');
});

test('mixed footer fonts wrap by measured width and reserve taller lines',()=>{
 const ctx={save(){},restore(){},font:'',measureText(text:string){return {width:[...text].length*10}}} as unknown as CanvasRenderingContext2D;
 const layout=layoutImageFooter(ctx,30,parseImageFooter({text:'甲<b>乙丙丁</b><br><span style="font-size:28px">戊</span>',padding:0})!);
 expect(layout.lines).toEqual(['甲乙丙','丁','戊']);
 expect(layout.rows?.map(row=>row.height)).toEqual([22,22,44]);
 expect(layout.height).toBe(88);
});

test('footer layout wraps Unicode at measured width, preserves blank lines and restores state',()=>{
 let saved=0;const ctx={save(){saved++},restore(){saved--},font:'',measureText(text:string){return {width:[...text].length*10}}} as unknown as CanvasRenderingContext2D;
 const config=parseImageFooter({text:'甲🐱乙\n\n尾',padding:0,lineHeight:22})!;
 expect(layoutImageFooter(ctx,20,config)).toEqual({height:88,lines:['甲🐱','乙','','尾']});
 expect(saved).toBe(0);
 expect(layoutImageFooter(ctx,10,parseImageFooter(undefined)!)).toEqual({height:0,lines:[]});
});
