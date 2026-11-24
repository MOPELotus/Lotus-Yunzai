import { expect, test } from "bun:test";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareZzzTuningTheme } from "../lib/zzz-tuning-theme.ts";

test("绝区零调频首次初始化固定到原上游素材，损坏主题不部分发布", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-zzz-tuning-theme-"));
  const root = pathToFileURL(directory + "/");
  const target = join(directory, "data", "zzz", "gacha-theme");
  try {
    expect(await prepareZzzTuningTheme(root)).toBe("missing");
    let requests = 0;
    expect(await prepareZzzTuningTheme(root, {
      async download(url, init) {
        requests++;
        expect(url.href).toBe("https://raw.githubusercontent.com/ZZZure/ZZZ-Plugin/20575991eb9cd51461d6a10b186c66b2fc8e2309/resources/common/fonts/inpinhongmengti.ttf");
        expect(init).toMatchObject({ redirect: "error", credentials: "omit" });
        return new Response(Buffer.alloc(1_925_852));
      },
    })).toBe("missing");
    expect(requests).toBe(1);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
