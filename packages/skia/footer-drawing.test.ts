import { expect, test } from 'bun:test';
import type { CanvasRenderingContext2D } from 'skia-canvas';
import { captureFooterDrawing } from './footer-drawing.ts';

test('footer capture extends only full backgrounds, normalizes half scale and restores methods',()=>{
 let transform={a:0.5,b:0,c:0,d:0.5,e:0,f:0};
 const fills:unknown[][]=[],images:unknown[][]=[];
 const ctx={getTransform:()=>transform,measureText:()=>({actualBoundingBoxDescent:2}),fillRect(...args:unknown[]){fills.push(args)},drawImage(...args:unknown[]){images.push(args)},fillText(){}} as unknown as CanvasRenderingContext2D;
 const original={fillRect:ctx.fillRect,drawImage:ctx.drawImage,fillText:ctx.fillText};
 const capture=captureFooterDrawing(ctx,1200,400,160);
 transform={...transform,a:2,d:2};
 ctx.fillRect(0,0,300,100);
 ctx.fillRect(10,10,30,20);
 ctx.drawImage({} as never,0,0,300,100);
 ctx.drawImage({} as never,0,0,100,100,0,0,300,100);
 ctx.fillText('Lotus-Yunzai',150,92);
 expect(fills).toEqual([[0,0,300,140],[10,10,30,20]]);
 expect(images[0]?.slice(1)).toEqual([0,0,300,140]);
 expect(images[1]?.slice(5)).toEqual([0,0,300,140]);
 expect(capture.brandBottom()).toBe(376);
 capture.restore();
 expect(ctx.fillRect).toBe(original.fillRect);expect(ctx.drawImage).toBe(original.drawImage);expect(ctx.fillText).toBe(original.fillText);
});
