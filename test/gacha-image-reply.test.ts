import { expect, test } from "bun:test";
import { setImageRenderPreset } from "@lotus-yunzai/skia";
import { gachaImageReply } from "../lib/gacha-image-reply.ts";
import type { MessageReply } from "../lib/messages.ts";

const signal = new AbortController().signal;
const base = {
  title: "合成样本，共 3 页", total: 3, signal, changedRoleMessage: "档案已切换",
  verifyRole: async () => true,
};

function pages(high: number, low: number) {
  const calls: Array<[number, number]> = [];
  return { calls, async render(page: number, scale: 1 | 2 | 4) {
    calls.push([page, scale]);
    return { png: new Uint8Array(scale === 4 ? high : low).fill(page) };
  } };
}

function pageOrder(nodes: readonly MessageReply[]) {
  return nodes.slice(1).map(node => (node as { readonly file: Uint8Array }).file[0]!);
}

test("keeps the exact budget ordinary forward at 4×", async () => {
  const render = pages(8, 4);
  const reply = await gachaImageReply({ ...base, ...render, inlineImageByteLimit: 24 });
  expect(reply).toMatchObject({ type: "forward" });
  expect(render.calls).toEqual([[1, 4], [2, 4], [3, 4]]);
});

test("aggregate bytes do not split a merged forward", async () => {
  const render = pages(8, 4), groups: number[][] = [];
  const reply = await gachaImageReply({ ...base, ...render, inlineImageByteLimit: 13,
    async forward(nodes) { groups.push(pageOrder(nodes)); return true; },
  });
  expect(reply).toEqual([]);
  expect(groups).toEqual([[1, 2, 3]]);
  expect(render.calls).toEqual([[1, 4], [2, 4], [3, 4]]);
});

test("only the 99-image node limit splits a merged forward", async () => {
  const groups: number[][] = [];
  const headings: MessageReply[] = [];
  const reply = await gachaImageReply({
    ...base, total: 101, ...pages(8, 4), inlineImageByteLimit: 8,
    async forward(nodes) {
      groups.push(pageOrder(nodes));
      headings.push(nodes[0]!);
      return true;
    },
  });
  expect(reply).toEqual([]);
  expect(groups).toEqual([Array.from({length:99},(_,i)=>i+1),[100,101]]);
  expect(headings).toEqual(["合成样本，共 3 页（第 1/2 段）", "合成样本，共 3 页（第 2/2 段）"]);
});

test("rejected and ambiguous forward attempts stop without repeating or sending later pages", async () => {
  for (const uncertain of [false, true]) {
    const sent: number[][] = [];
    const reply = await gachaImageReply({
      ...base, ...pages(8, 4), inlineImageByteLimit: 8,
      async forward(nodes) {
        sent.push(pageOrder(nodes));
        if (uncertain) throw new Error("unknown receipt");
        return false;
      },
    });
    expect(sent).toEqual([[1,2,3]]);
    expect(reply).toContain(uncertain ? "结果未确认" : "未发送");
  }
});

test("checks actual role again between confirmed split sends", async () => {
  let sends = 0;
  const reply = await gachaImageReply({
    ...base, total:100, ...pages(8, 4), inlineImageByteLimit: 8, verifyRole: async () => sends === 0,
    async forward() { sends++; return true; },
  });
  expect(sends).toBe(1);
  expect(reply).toBe(base.changedRoleMessage);
});

test("a single 2× page above the byte limit is never offered for sending", async () => {
  let forwards = 0;
  const reply = await gachaImageReply({
    ...base, ...pages(16, 9), inlineImageByteLimit: 8,
    async forward() { forwards++; return true; },
  });
  expect(forwards).toBe(0);
  expect(reply).toContain("单页图片仍超过");
});

test("低配按原分页一次出图，单页超限时保留文字回执", async () => {
  const render = pages(8, 4);
  const sent: number[][] = [];
  setImageRenderPreset("low");
  try {
    const reply = await gachaImageReply({
      ...base, ...render, inlineImageByteLimit: 8,
      async forward(nodes) { sent.push(pageOrder(nodes)); return true; },
    });
    expect(reply).toEqual([]);
    expect(sent).toEqual([[1, 2, 3]]);
    expect(render.calls).toEqual([[1, 1], [2, 1], [3, 1]]);
    const oversized = pages(8, 9);
    expect(await gachaImageReply({ ...base, ...oversized, inlineImageByteLimit: 8 })).toContain("单页图片仍超过");
    expect(oversized.calls).toEqual([[1, 1]]);
  } finally {
    setImageRenderPreset("standard");
  }
});

test('one original image is sent directly without a merged forward',async()=>{
 const renderer=pages(8,4);
 const reply=await gachaImageReply({...base,...renderer,total:1,inlineImageByteLimit:8});
 expect(reply).toMatchObject({type:'image'});
 expect(renderer.calls).toEqual([[1,4]]);
});
