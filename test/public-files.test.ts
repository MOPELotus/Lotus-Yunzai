import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileToUrl, createImageToUrl } from "../lib/file-to-url.ts";
import { createPublicFiles, maxPublicFileBytes } from "../lib/public-files.ts";

function request(path: string, method = "GET", headers?: HeadersInit) {
  return new Request(new URL(path, "http://127.0.0.1:2536/"), { method, headers });
}

test("临时文件注册不可变字节，HTML 和 SVG 按安全附件下载", async () => {
  const files = createPublicFiles();
  try {
    const input = Uint8Array.of(9, 1, 2, 3, 8);
    const path = files.register(input.subarray(1, 4), {
      name: "../群资料\r\n.svg", mime: "image/svg+xml", timeMs: 60_000,
    });
    input.fill(0);
    expect(path).toMatch(/^File\/[a-f0-9-]{36}$/u);
    const response = files.handle(request(path))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("3");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"______.svg\"; filename*=UTF-8''_%E7%BE%A4%E8%B5%84%E6%96%99__.svg",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));

    for (const [mime, expected] of [["text/html", "application/octet-stream"], [" IMAGE/PNG ", "image/png"]] as const) {
      const file = files.register(new Uint8Array(), { name: "测试.png", mime, timeMs: 0 });
      expect(files.handle(request(file))?.headers.get("Content-Type")).toBe(expected);
    }
  } finally {
    files.close();
  }
});

test("路由只识别精确令牌，HEAD 与禁用方法不扣次数，最后一个 GET 可完整读取", async () => {
  const files = createPublicFiles();
  try {
    const bytes = new TextEncoder().encode("fixture body");
    const path = files.register(bytes, { timeMs: 0, times: 1 });
    const other = files.register(bytes, { timeMs: 0, times: 0 });
    expect(other).not.toBe(path);
    expect(files.handle(request(other))?.status).toBe(404);
    expect(files.handle(request("/status"))).toBeUndefined();
    expect(files.handle(request("/file/" + path.slice(5)))).toBeUndefined();
    expect(files.handle(request("/FileBackup/hello"))).toBeUndefined();
    for (const invalid of ["/File", "/File/", "/File/not-a-token", path + "/extra", path + "?secret=1",
      "/File/%2F" + path.slice(5), "/File/" + crypto.randomUUID()]) {
      expect(files.handle(request(invalid))?.status).toBe(404);
    }
    const head = files.handle(request(path, "HEAD"))!;
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(bytes.byteLength));
    expect(await head.text()).toBe("");
    const post = files.handle(request(path, "POST"))!;
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD");
    const first = files.handle(request(path))!;
    const second = files.handle(request(path))!;
    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
    expect(await first.text()).toBe("fixture body");
    expect(files.handle(request(path, "HEAD"))?.status).toBe(404);
  } finally {
    files.close();
  }
});

test("到期边界立即失效，零时长无限期，关闭后回收目录", () => {
  const clock = spyOn(performance, "now").mockReturnValue(100);
  const files = createPublicFiles();
  try {
    const bytes = Uint8Array.of(1);
    const finite = files.register(bytes, { timeMs: 20 });
    const permanent = files.register(bytes, { timeMs: 0 });
    clock.mockReturnValue(119);
    expect(files.handle(request(finite))?.status).toBe(200);
    clock.mockReturnValue(120);
    expect(files.handle(request(finite))?.status).toBe(404);
    clock.mockReturnValue(100_000);
    expect(files.handle(request(permanent))?.status).toBe(200);
    expect(files.handle(request(permanent))?.status).toBe(200);
    files.close();
    files.close();
    expect(files.handle(request(permanent))?.status).toBe(404);
    expect(() => files.register(bytes, { timeMs: 0 })).toThrow("服务已关闭");
  } finally {
    files.close();
    clock.mockRestore();
  }
});

test("拒绝路径、FileRef、非法定额和过大字节，限制总容量及条目数", () => {
  const clock = spyOn(performance, "now").mockReturnValue(50);
  const files = createPublicFiles();
  try {
    for (const invalid of ["./some/file", new Blob(["not bytes"]), Bun.file(import.meta.path), new Uint16Array(1)]) {
      expect(() => files.register(invalid as unknown as Uint8Array, { timeMs: 0 })).toThrow("字节数据");
    }
    const bytes = Uint8Array.of(1);
    for (const timeMs of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => files.register(bytes, { timeMs })).toThrow("有效期或访问次数");
    }
    for (const times of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => files.register(bytes, { timeMs: 0, times })).toThrow("有效期或访问次数");
    }
    expect(() => files.register(new Uint8Array(maxPublicFileBytes + 1), { timeMs: 0 })).toThrow("字节数据");
    const block = new Uint8Array(maxPublicFileBytes);
    for (let i = 0; i < 4; i++) files.register(block, { timeMs: 10 });
    expect(() => files.register(bytes, { timeMs: 0 })).toThrow("容量已满");
    clock.mockReturnValue(60);
    for (let i = 0; i < 256; i++) files.register(bytes, { timeMs: 10 });
    expect(() => files.register(bytes, { timeMs: 0 })).toThrow("容量已满");
    expect(files.handle(request(files.register(bytes, { timeMs: 0, times: 0 })))?.status).toBe(404);
    clock.mockReturnValue(70);
    expect(files.handle(request(files.register(bytes, { timeMs: 0 })))?.status).toBe(200);
  } finally {
    files.close();
    clock.mockRestore();
  }
});

test("旧图片分享只读获准目录内有界栅格字节，沿用公共链接的访问次数", async () => {
  const work = await mkdtemp(join(tmpdir(), "lotus-public-image-"));
  const directory = join(work, "images");
  const outside = join(work, "images-other");
  const image = join(directory, "许可.png");
  const alias = join(directory, "链接.png");
  const other = join(outside, "外面.png");
  const escape = join(directory, "越界.png");
  const text = join(directory, "伪装.png");
  const truncated = join(directory, "截断.png");
  const emptyContainer = join(directory, "缺正文.png");
  const large = join(directory, "大图.png");
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=", "base64");
  const files = createPublicFiles();
  const publish = createFileToUrl(files, { file_to_url_times: 1 }, () => new URL("https://example.invalid/prefix/"));
  try {
    await Promise.all([mkdir(directory), mkdir(outside)]);
    await Promise.all([writeFile(image, bytes), writeFile(other, bytes), writeFile(text, "非图片"), writeFile(large, bytes)]);
    await Promise.all([writeFile(truncated, bytes.subarray(0, -12)),
      writeFile(emptyContainer, Buffer.concat([bytes.subarray(0, 33), bytes.subarray(-12)]))]);
    await Promise.all([symlink(other, escape), symlink(image, alias), truncate(large, maxPublicFileBytes + 1)]);
    await expect(createImageToUrl(publish, undefined)(image)).rejects.toThrow("未设置");
    const shares = createImageToUrl(publish, directory);
    for (const candidate of [other, escape, text, truncated, emptyContainer, large, directory, "https://example.invalid/pic.png"]) {
      await expect(shares(candidate)).rejects.toThrow("本地图像");
    }

    const url = new URL(await shares(alias, { name: "原图.png" }));
    expect(url.origin).toBe("https://example.invalid");
    expect(url.pathname).toMatch(/^\/prefix\/File\/[a-f0-9-]{36}$/u);
    const path = url.pathname.slice("/prefix".length);
    expect(files.handle(request(path, "HEAD"))?.headers.get("Content-Type")).toBe("image/png");
    const response = files.handle(request(path))!;
    expect(response.headers.get("Content-Disposition")).toContain("%E5%8E%9F%E5%9B%BE.png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(files.handle(request(path))?.status).toBe(404);
  } finally {
    files.close();
    await rm(work, { recursive: true, force: true });
  }
});
