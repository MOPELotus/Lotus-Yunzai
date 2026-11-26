import { expect, test } from "bun:test";
import { renderRankPages } from "../lib/rank-pages.ts";

test("ranking forwards every row in pages of thirty with continuous offsets", async () => {
 for(const size of [1,30,31,61,103]) {
  const rows=Array.from({length:size},(_,i)=>i+1), pages:number[][]=[];
  const reply=await renderRankPages(rows,async (page, pagination)=>{
   expect(pagination.offset).toBe(pages.length*30);
   expect(pagination.page).toBe(pages.length+1);
   expect(pagination.total).toBe(Math.ceil(size/30));
   pages.push([...page]);return {png:Buffer.from(String(page[0]))};
  },new AbortController().signal);
  expect(reply?.type).toBe("forward");expect(reply?.nodes.length).toBe(Math.ceil(size/30));
  expect(pages.flat()).toEqual(rows);expect(pages.every(p=>p.length<=30)).toBe(true);
 }
});
test("ranking never returns a partial forward when a later page fails or is cancelled", async()=>{
 const rows=Array.from({length:61},(_,i)=>i);
 expect(await renderRankPages(rows,async(_,p)=>p.page===2?undefined:{png:Buffer.from([1])},new AbortController().signal)).toBeUndefined();
 const controller=new AbortController();
 await expect(renderRankPages(rows,async()=>{controller.abort();return {png:Buffer.from([1])};},controller.signal)).rejects.toThrow();
});
