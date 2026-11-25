import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("skia", messageCatalog.messages);
import { createDeflate } from "node:zlib";

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maxEncodedBytes = 128 * 1024 * 1024;

export class ImageSizeLimitError extends RangeError {}

function chunk(type: string, data = Buffer.alloc(0)): Buffer {
  const result = Buffer.allocUnsafe(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(Bun.hash.crc32(result.subarray(4, 8 + data.length)), 8 + data.length);
  return result;
}

/** Encode RGBA bands as one PNG. The encoder does not allocate a second full image. */
export async function encodeBandedPng(width: number, height: number, bands: AsyncIterable<Buffer>): Promise<Buffer> {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const parts = [pngSignature, chunk("IHDR", header)];
  let length = pngSignature.length + parts[1]!.length;
  const stride = width * 4;
  const compressor = createDeflate();

  async function collect() {
    for await (const bytes of compressor) {
      length += bytes.length + 12;
      if (length > maxEncodedBytes) throw new ImageSizeLimitError($t("banded-png.text_c7d41ac028"));
      parts.push(chunk("IDAT", bytes));
    }
  }

  async function writeRows() {
    const batchRows = Math.max(1, Math.floor(256 * 1024 / (stride + 1)));
    let previous: Buffer | undefined;
    let rows = 0;
    for await (const band of bands) {
      if (band.length < stride || band.length % stride !== 0 || rows + band.length / stride > height) {
        throw new Error($t("banded-png.text_588387e089"));
      }
      const bandRows = band.length / stride;
      for (let start = 0; start < bandRows; start += batchRows) {
        const count = Math.min(batchRows, bandRows - start);
        const filtered = Buffer.allocUnsafe(count * (stride + 1));
        for (let row = 0; row < count; row++) {
          const input = (start + row) * stride;
          const output = row * (stride + 1);
          const pixels = band.subarray(input, input + stride);
          filtered[output] = previous === undefined ? 0 : 2;
          if (previous === undefined) {
            pixels.copy(filtered, output + 1);
          } else {
            for (let byte = 0; byte < stride; byte++) filtered[output + 1 + byte] = pixels[byte]! - previous[byte]!;
          }
          previous = pixels;
        }
        await new Promise<void>((resolve, reject) => {
          compressor.write(filtered, error => error ? reject(error) : resolve());
        });
      }
      rows += bandRows;
    }
    if (rows !== height) throw new Error($t("banded-png.text_82c11fc05a"));
    compressor.end();
  }

  try {
    await Promise.all([collect(), writeRows()]);
  } finally {
    compressor.destroy();
  }
  const end = chunk("IEND");
  parts.push(end);
  return Buffer.concat(parts, length + end.length);
}
