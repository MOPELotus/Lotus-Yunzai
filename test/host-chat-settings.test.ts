import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createChatSettings } from "../lib/chat-settings.ts";

test("默认状态按运行时的相对覆盖路径写入，坏 YAML 只报失败且可恢复", async () => {
  const install = await mkdtemp(join(tmpdir(), "lotus-chat-status-settings-"));
  const file = join(install, "custom", "runtime-status.yaml");
  const previous = Bun.env.LOTUS_SYSTEM_STATUS_CONFIG;
  Bun.env.LOTUS_SYSTEM_STATUS_CONFIG = relative(process.cwd(), file);
  try {
    const directories = new Map([["system", {
      packageName: "@lotus-yunzai/system",
      path: join(import.meta.dir, "../plugins/system"),
    }]]);
    const configure = createChatSettings(pathToFileURL(install + "/"), directories);
    const canWrite = () => true;
    const signal = new AbortController().signal;
    await mkdir(join(install, "custom"));
    const broken = "defaultState: [\n";
    await writeFile(file, broken);
    expect(await configure({ setting: "状态", enabled: true }, canWrite, signal)).toContain("无法保存默认状态");
    expect(await readFile(file, "utf8")).toBe(broken);
    await writeFile(file, "# retain\ndefaultState: false\nnoPro: true\n");
    expect(await configure({ setting: "状态", enabled: true }, canWrite, signal)).toContain("默认状态 已开启");
    expect(await readFile(file, "utf8")).toBe("# retain\ndefaultState: true\nnoPro: true\n");
    expect(await Bun.file(join(install, "config/system-status.yaml")).exists()).toBe(false);
  } finally {
    if (previous === undefined) delete Bun.env.LOTUS_SYSTEM_STATUS_CONFIG;
    else Bun.env.LOTUS_SYSTEM_STATUS_CONFIG = previous;
    await rm(install, { recursive: true, force: true });
  }
});
