import { expect, test } from 'bun:test';
import { splitGachaPoolPages, subdivideGachaPage } from '../lib/gacha-pool-pages.ts';
import { gachaImageReply } from '../lib/gacha-image-reply.ts';

test('pool pages preserve every record and full statistics without mixing pools', () => {
  const model={ uid:'test',data:[{type:'role',total:40,list:Array.from({length:29},(_,id)=>({id}))},{type:'weapon',total:3,list:[{id:30}]},{type:'empty',total:0,list:[]}] };
  const pages=splitGachaPoolPages(model,'data','list');
  expect(pages.map(p=>p.data.length)).toEqual([1,1,1,1,1]);
  expect(pages.flatMap(p=>p.data.flatMap(x=>x.list.map(v=>v.id)))).toEqual([...Array(29).keys(),30]);
  expect(pages.filter(p=>p.data[0]!.type==='role').every(p=>p.data[0]!.total===40)).toBe(true);
  expect(model.data[0]!.list).toHaveLength(29);
});

test('oversized cards split content recursively at the same raster scale', async () => {
  const plans=splitGachaPoolPages({uid:'test',data:[{list:[1,2,3,4,5,6]}]},'data','list').map(model=>({model}));
  const scales:number[]=[],received:number[]=[];
  const reply=await gachaImageReply({total:plans.length,title:'test',signal:new AbortController().signal,
    verifyRole:async()=>true,changedRoleMessage:'changed',inlineImageByteLimit:3,
    splitPage:page=>subdivideGachaPage(plans,page,'data','list'),
    async render(page,scale){scales.push(scale);return {png:Uint8Array.from(plans[page-1]!.model.data[0]!.list)};},
    async forward(nodes){for(const n of nodes)if(typeof n==='object'&&n&&'file'in n)received.push(...(n.file as Uint8Array));return true;},
  });
  expect(reply).toEqual([]);
  expect(received).toEqual([1,2,3,4,5,6]);
  expect(scales.every(s=>s===4)).toBe(true);
});
