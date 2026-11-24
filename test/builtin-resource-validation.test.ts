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
