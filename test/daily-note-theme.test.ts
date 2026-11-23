import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareDailyNoteTheme } from "../lib/daily-note-theme.ts";
import { dailyNoteAssets, dailyNoteResourcePath, dailyNoteSourceRevision } from "../packages/skia/daily-note-assets.ts";

test("普通启动不下载便笺原素材，首次初始化只请求固定文件且损坏响应不发布目录", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-note-theme-"));
  try {
    const root = pathToFileURL(directory + "/");
    const target = join(directory, dailyNoteResourcePath);
    expect(await prepareDailyNoteTheme(root)).toBe("missing");
    const requested: string[] = [];
    expect(await prepareDailyNoteTheme(root, {
      async download(url, init) {
        expect(url.origin).toBe("https://raw.githubusercontent.com");
        expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
        const prefix = `/MOPELotus/Lotus-ReFactor/${dailyNoteSourceRevision}/resources/`;
        const location = decodeURIComponent(url.pathname);
        expect(location.startsWith(prefix)).toBe(true);
        const path = location.slice(prefix.length);
        requested.push(path);
        if (requested.length === 1) throw Object.assign(new Error("暂时断开"), { code: "ECONNRESET" });
        return new Response(Buffer.alloc(dailyNoteAssets[0]![1]));
      },
    })).toBe("missing");
    const [firstAsset] = dailyNoteAssets[0]!;
    expect(requested).toEqual([firstAsset, firstAsset]);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("便笺主题保留现有本地目录和覆盖设置，拒绝覆盖部分路径", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-note-theme-local-"));
  try {
    const root = pathToFileURL(directory + "/");
    const target = join(directory, dailyNoteResourcePath);
    const local = join(directory, "approved-local-theme");
    let downloads = 0;
    const download = async () => { downloads++; throw new Error("意外请求网络"); };
    expect(await prepareDailyNoteTheme(root, { override: local, download })).toBe("configured");
    const [asset] = dailyNoteAssets[0]!;
    await mkdir(dirname(join(local, asset)), { recursive: true });
    await writeFile(join(local, asset), "已有主题");
    await mkdir(dirname(target), { recursive: true });
    await symlink(local, target);
    expect(await prepareDailyNoteTheme(root, { download })).toBe("incomplete");
    expect(await Bun.file(join(local, asset)).text()).toBe("已有主题");
    for (const [child] of dailyNoteAssets.slice(1)) {
      await mkdir(dirname(join(local, child)), { recursive: true });
      await writeFile(join(local, child), "本地素材");
    }
    expect(await prepareDailyNoteTheme(root, { download })).toBe("available");
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(downloads).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("取消便笺初始化时抛回原取消原因并清理候选", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-note-theme-cancel-"));
  const abort = new AbortController();
  const reason = new Error("取消初始化");
  try {
    await expect(prepareDailyNoteTheme(pathToFileURL(directory + "/"), {
      signal: abort.signal,
      async download(_url, { signal }) {
        abort.abort(reason);
        signal?.throwIfAborted();
        throw new Error("验收未看到取消信号");
      },
    })).rejects.toBe(reason);
    await expect(lstat(join(directory, dailyNoteResourcePath))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
