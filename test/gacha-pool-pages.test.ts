import { expect, test } from 'bun:test';
import { splitGachaPoolPages } from '../lib/gacha-pool-pages.ts';
import { gachaImageReply } from '../lib/gacha-image-reply.ts';

test('pool pages preserve every record and full statistics without mixing pools', () => {
  const model={ uid:'test',data:[{type:'role',total:40,list:Array.from({length:29},(_,id)=>({id}))},{type:'weapon',total:3,list:[{id:30}]},{type:'empty',total:0,list:[]}] };
  const pages=splitGachaPoolPages(model,'data','list');
  expect(pages.map(p=>p.data.length)).toEqual([1,1,1]);
  expect(pages[0]!.data[0]!.list).toHaveLength(29);
  expect(pages.flatMap(p=>p.data.flatMap(x=>x.list.map(v=>v.id)))).toEqual([...Array(29).keys(),30]);
  expect(pages.filter(p=>p.data[0]!.type==='role').every(p=>p.data[0]!.total===40)).toBe(true);
  expect(model.data[0]!.list).toHaveLength(29);
});
