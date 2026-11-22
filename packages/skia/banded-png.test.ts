import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import type { CanvasRenderingContext2D } from "skia-canvas";
import { encodeBandedPng } from "./banded-png.ts";
import { nativeImageRasterScale, renderPng, setImageRenderPreset } from "./index.ts";

async function* bands(...parts: Buffer[]) {
  yield* parts;
}

test("帧带共享同一个 PNG 数据流，跨带保留上一行预测值", async () => {
  const first = Buffer.from([64, 10, 20, 255, 30, 20, 10, 255]);
  const second = Buffer.from([10, 20, 30, 64, 50, 50, 50, 64]);
  const png = await encodeBandedPng(2, 2, bands(first, second));
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]]).toEqual([2, 2, 8, 6]);
  const payloads = [];
  const types = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const next = offset + length + 8;
    expect(png.readUInt32BE(next)).toBe(Bun.hash.crc32(png.subarray(offset + 4, next)));
    types.push(type);
    if (type === "IDAT") payloads.push(png.subarray(offset + 8, next));
    offset = next + 4;
  }
  expect(types[0]).toBe("IHDR");
  expect(types.at(-1)).toBe("IEND");
  const data = inflateSync(Buffer.concat(payloads));
  expect(data).toEqual(Buffer.concat([
    Buffer.from([0]), first, Buffer.from([2]),
    Buffer.from(second.map((pixel, index) => pixel - first[index]!)),
  ]));
});

test("编码拒绝尺寸错误与缺行，渲染在申请画布前拒绝超出像素范围", async () => {
  await expect(encodeBandedPng(2, 2, bands(Buffer.alloc(7)))).rejects.toThrow("像素尺寸不匹配");
  await expect(encodeBandedPng(2, 2, bands(Buffer.alloc(8)))).rejects.toThrow("没有覆盖全部画布");
  let paints = 0;
  await expect(renderPng(32_768, 32_768, () => { paints++; }, "gpu")).rejects.toThrow("总像素");
  expect(paints).toBe(0);
});

test("低配档在分配画布前按 1× 直接绘制，旧设置仍是标准档", async () => {
  const draw = (context: CanvasRenderingContext2D) => {
    context.scale(4, 4);
    context.fillStyle = "#005fcc";
    context.fillRect(4, 6, 80, 48);
  };
  const size = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];
  try {
    setImageRenderPreset(undefined);
    expect(nativeImageRasterScale()).toBe(4);
    expect(size((await renderPng(404, 283, draw)).png)).toEqual([404, 283]);
    setImageRenderPreset("low");
    expect(nativeImageRasterScale()).toBe(1);
    const result = await renderPng(404, 283, draw, "auto", { allowHalfScale: true });
    expect(size(result.png)).toEqual([101, 71]);
    expect(result.reducedScaleReason).toBeUndefined();
  } finally {
    setImageRenderPreset("standard");
  }
});
