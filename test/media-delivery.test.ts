import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMediaDelivery } from "../lib/media-delivery.ts";

async function taskFixture(data: string) {
  const parent = join(data, "bilibili", "tasks");
  await mkdir(parent, { recursive: true });
  const task = await mkdtemp(join(parent, "task-"));
  await writeFile(join(task, ".lotus-media-task.json"), JSON.stringify({ version: 1, pid: process.pid }));
  return task;
}

test("媒体链接可经真实 HTTP 递送大文件，源任务清理后依然可读", async () => {
  const data = await mkdtemp(join(tmpdir(), "lotus-media-test-"));
  let origin: URL | undefined;
  const bridge = createMediaDelivery(data, () => origin);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => bridge.handle(request) ?? new Response(null, { status: 404 }) });
  origin = server.url;
  try {
    const task = await taskFixture(data);
    const path = join(task, "中文.mp4");
    const stale = await mkdtemp(join(data, ".media-delivery-999999999-"));
    const unrelated = await mkdtemp(join(data, ".media-delivery-999999999-"));
    const oldFile = join(stale, crypto.randomUUID());
    const localData = join(unrelated, "keep.txt");
    await Promise.all([writeFile(oldFile, "old attachment"), writeFile(localData, "local data")]);
    const fourMinutesAgo = new Date(Date.now() - 240_000);
    await Promise.all([utimes(stale, fourMinutesAgo, fourMinutesAgo), utimes(unrelated, fourMinutesAgo, fourMinutesAgo)]);
    const body = new Uint8Array(17 * 1024 * 1024);
    body[0] = 42;
    body[body.length - 1] = 73;
    await writeFile(path, body);
    let published: string | undefined;
    expect(await bridge.deliver({ path, name: "中文.mp4", type: "video" }, async (url, name, type) => {
      expect(name).toBe("中文.mp4");
      expect(type).toBe("video");
      published = url;
      return "confirmed";
    })).toBe("confirmed");
    expect(await Bun.file(oldFile).exists()).toBe(false);
    expect(await Bun.file(localData).text()).toBe("local data");
    await rm(task, { recursive: true });
    const head = await fetch(published!, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(body.length));
    expect(head.headers.get("content-type")).toBe("video/mp4");
    const response = await fetch(published!);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = new Uint8Array(await response.arrayBuffer());
    expect(result.length).toBe(body.length);
    expect([result[0], result.at(-1)]).toEqual([42, 73]);
    expect((await fetch(published! + "?x")).status).toBe(404);
    expect((await fetch(published!, { method: "POST" })).status).toBe(405);
    await bridge.close();
    expect((await fetch(published!)).status).toBe(404);
  } finally {
    await bridge.close();
    server.stop(true);
    await rm(data, { recursive: true });
  }
});

test("媒体递送拒绝非任务和越界文件，仅保留未确认的临时链接", async () => {
  const data = await mkdtemp(join(tmpdir(), "lotus-media-test-"));
  const bridge = createMediaDelivery(data, () => new URL("http://127.0.0.1:6789/"), 100);
  try {
    const task = await taskFixture(data);
    const path = join(task, "clip.mp4");
    const outside = join(data, "outside.mp4");
    const alias = join(task, "follow.mp4");
    await Promise.all([writeFile(path, "fixture"), writeFile(outside, "fixture"), symlink(outside, alias)]);
    let sent = 0;
    let url: string | undefined;
    const send = async (link: string) => { sent++; url = link; return "rejected" as const; };
    for (const invalid of [outside, alias, join(task, ".lotus-media-task.json")]) {
      expect(await bridge.deliver({ path: invalid, name: "clip.mp4", type: "file" }, send)).toBe("rejected");
    }
    expect(sent).toBe(0);
    expect(await bridge.deliver({ path, name: "clip.mp4", type: "file" }, send)).toBe("rejected");
    expect(bridge.handle(new Request(url!))?.status).toBe(404);
    expect(await bridge.deliver({ path, name: "clip.mp4", type: "file" }, async (link) => {
      url = link;
      throw new Error("未确认回执");
    })).toBe("unknown");
    expect(await bridge.handle(new Request(url!))?.text()).toBe("fixture");
    await Bun.sleep(120);
    expect(bridge.handle(new Request(url!))?.status).toBe(404);
  } finally {
    await bridge.close();
    await rm(data, { recursive: true });
  }
});
