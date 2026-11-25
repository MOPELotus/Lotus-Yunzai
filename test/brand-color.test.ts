import { describe, expect, test } from "bun:test";
import { brandTextColor } from "../packages/skia/brand-color.ts";
function fixture(rgba = [255,255,255,255], transform = {a:1,b:0,c:0,d:1,e:0,f:0}) {
 const reads:number[][]=[];
 const context = {canvas:{width:4000,height:4000},measureText:()=>({actualBoundingBoxLeft:10,actualBoundingBoxRight:90,actualBoundingBoxAscent:8,actualBoundingBoxDescent:2}),getTransform:()=>transform,
 getImageData:(...bounds:number[])=>{reads.push(bounds); return {data:new Uint8ClampedArray(rgba)}}};
 return {context:context as any,reads};
}
describe("brand signature background contrast",()=>{
 test("light, dark, and transparent backgrounds",()=>{
  expect(brandTextColor(fixture().context,"Brand",30,20)).toBe("#000");
  expect(brandTextColor(fixture([0,0,0,255]).context,"Brand",30,20)).toBe("#fff");
  expect(brandTextColor(fixture([0,0,0,0]).context,"Brand",30,20)).toBe("#000");
 });
 test("maps text bounds through render scaling and tile translation",()=>{
  const {context,reads}=fixture(undefined,{a:4,b:0,c:0,d:4,e:0,f:-40});
  brandTextColor(context,"Brand",30,20);
  expect(reads).toEqual([[80,8,400,40]]);
 });
 test("clips off-canvas regions and skips wholly invisible text",()=>{
  const {context,reads}=fixture(); brandTextColor(context,"Brand",0,0);
  expect(reads).toEqual([[0,0,90,2]]);
  expect(brandTextColor(context,"Brand",0,-100)).toBe("#fff");expect(reads.length).toBe(1);
 });
 test("limits GPU readback and safely handles unavailable readback",()=>{
  const {context,reads}=fixture(undefined,{a:100,b:0,c:0,d:100,e:0,f:0});brandTextColor(context,"Brand",30,20);
  expect(reads[0]![2]!*reads[0]![3]!).toBeLessThanOrEqual(262144);
  context.getImageData=()=>{throw Error("unavailable")};expect(brandTextColor(context,"Brand",30,20,undefined,"#000")).toBe("#000");
 });
});
