import { expect, test } from 'bun:test';
import { getImageFooter, setImageFooter, parseImageFooter, layoutImageFooter } from './custom-footer.ts';
import type { CanvasRenderingContext2D } from 'skia-canvas';

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

test('footer layout wraps Unicode at measured width, preserves blank lines and restores state',()=>{
 let saved=0;const ctx={save(){saved++},restore(){saved--},font:'',measureText(text:string){return {width:[...text].length*10}}} as unknown as CanvasRenderingContext2D;
 const config=parseImageFooter({text:'甲🐱乙\n\n尾',padding:0,lineHeight:22})!;
 expect(layoutImageFooter(ctx,20,config)).toEqual({height:88,lines:['甲🐱','乙','','尾']});
 expect(saved).toBe(0);
 expect(layoutImageFooter(ctx,10,parseImageFooter(undefined)!)).toEqual({height:0,lines:[]});
});
