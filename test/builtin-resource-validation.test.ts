import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyBuiltinResources } from "../lib/builtin-resource-validation.ts";

test("初始化逐件核对内置资源，缺失、篡改和目录越界均失败", async () => {
  const path = await mkdtemp(join(tmpdir(), "lotus-builtin-check-"));
  const root = Bun.pathToFileURL(path + "/");
  const asset = join(path, "resources/builtin/image.txt");
  try {
    await mkdir(join(path, "resources/builtin"), { recursive: true });
    const entry = { path: "resources/builtin/image.txt", bytes: 5,
      sha256: new Bun.CryptoHasher("sha256").update("asset").digest("hex") };
    const save = (value = entry) => writeFile(join(path, "resources/builtin/manifest.json"), JSON.stringify({ format: 1, files: [value] }));
    await save();
    await expect(verifyBuiltinResources(root)).rejects.toThrow("缺失");
    await writeFile(asset, "asset");
    expect(await verifyBuiltinResources(root)).toEqual({ checked: 1, bytes: 5 });
    await writeFile(asset, "alter");
    await expect(verifyBuiltinResources(root)).rejects.toThrow("校验失败");
    await save({ ...entry, path: "resources/builtin/../../private" });
    await expect(verifyBuiltinResources(root)).rejects.toThrow("条目无效");
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("离线初始化补齐普通不完整主题，并保留已有自定义文件", async () => {
  const { prepareFixedTheme } = await import("../lib/fixed-theme.ts");
  const path = await mkdtemp(join(tmpdir(), "lotus-theme-repair-"));
  const root = Bun.pathToFileURL(path + "/");
  const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
  try {
    await mkdir(join(path, "data/theme"), { recursive: true });
    await mkdir(join(path, "resources/builtin/test"), { recursive: true });
    await writeFile(join(path, "data/theme/a.txt"), "custom");
    await writeFile(join(path, "resources/builtin/test/a.txt"), "a");
    await writeFile(join(path, "resources/builtin/test/b.txt"), "b");
    expect(await prepareFixedTheme(root, { resourcePath: "data/theme", sourceRoots: ["resources/builtin/test"],
      raw: "https://fixture.invalid/", assets: [["a.txt", 1, digest("a")], ["b.txt", 1, digest("b")]],
    })).toBe("installed");
    expect(await Bun.file(join(path, "data/theme/a.txt")).text()).toBe("custom");
    expect(await Bun.file(join(path, "data/theme/b.txt")).text()).toBe("b");
  } finally { await rm(path, { recursive: true, force: true }); }
});
