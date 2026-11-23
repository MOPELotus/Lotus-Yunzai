import { expect, test } from "bun:test";
import { previewKeywordList } from "../lib/keyword-list-preview.ts";

const validId = "a".repeat(32);
const invalidId = "b".repeat(32);
const validPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

test("已验证的 QQ 图片与表情使用协议段，群名片是纯文本，无法识别时保留原标签", async () => {
  const calls: string[] = [];
  const source = `图{image_${validId}} 表情{face:14}{face_7} {at:12345} {at:23456} 未知{image:${invalidId}} {image:https://router.invalid/} {face:-1}`;
  const result = await previewKeywordList(source, {
    group: 77,
    async readMember(group, id) {
      expect(group).toBe(77);
      return id === 12345 ? " 冒号:群名片\u202e " : undefined;
    },
    async readMedia(url, signal, maxBytes) {
      expect(signal.aborted).toBe(false);
      expect(maxBytes).toBe(1024 * 1024);
      calls.push(url);
      return url.includes(validId.toUpperCase()) ? validPng : Buffer.from("fake");
    },
  });
  expect(result).toEqual(["图", { type: "image", file: validPng }, " 表情", { type: "face", id: 14 },
    { type: "face", id: 7 }, " ", "@冒号:群名片", " ", "{at:23456}", " 未知", `{image:${invalidId}}`,
    " {image:https://router.invalid/} {face:-1}"]);
  expect(calls).toEqual([validId, invalidId].map(id => `https://gchat.qpic.cn/gchatpic_new/0/0-0-${id.toUpperCase()}/0`));
});

test("无群上下文或连接已撤销时保留旧键，重复图片与名字只读一次", async () => {
  const controller = new AbortController();
  const image = `{image:${validId}}`;
  let reads = 0;
  let lookups = 0;
  const readers = {
    async readMedia() { reads++; return validPng; },
    async readMember() { lookups++; return "群昵称"; },
  };
  expect(await previewKeywordList("{at:12345}", readers)).toBe("{at:12345}");
  expect(lookups).toBe(0);
  controller.abort();
  expect(await previewKeywordList(image, { ...readers, group: 77, connection: controller.signal })).toBe(image);
  expect(reads).toBe(0);
  expect(await previewKeywordList(image.repeat(5) + "{at:12345}{at:12345}", { ...readers, group: 77 })).toEqual([
    ...Array.from({ length: 4 }, () => ({ type: "image" as const, file: validPng })), image, "@群昵称", "@群昵称",
  ]);
  expect({ reads, lookups }).toEqual({ reads: 1, lookups: 1 });
});
