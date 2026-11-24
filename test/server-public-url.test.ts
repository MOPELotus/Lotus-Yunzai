import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readServerSettings } from "../lib/server.ts";

async function withConfig(run: (root: URL, writeConfig: (content: string, legacy?: boolean) => Promise<void>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-public-url-"));
  const root = pathToFileURL(`${directory}/`);
  try {
    await run(root, async (content, legacy = false) => {
      const configDirectory = join(directory, legacy ? "config/config" : "config");
      await mkdir(configDirectory, { recursive: true });
      await writeFile(join(configDirectory, "server.yaml"), content);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("公共 HTTP 地址保留代理路径，以及原有的监听地址和端口", async () => {
  await withConfig(async (root, writeConfig) => {
    await writeConfig("url: https://public.example:8443/bots/my%20lotus///\nport: 2536\n");
    const settings = await readServerSettings(root, {
      LOTUS_LISTEN_HOST: "0.0.0.0", LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "25360", LOTUS_ONEBOT_TOKEN: "fixture",
    });
    expect(settings.publicUrl?.href).toBe("https://public.example:8443/bots/my%20lotus/");
    expect(new URL("status", settings.publicUrl).href).toBe("https://public.example:8443/bots/my%20lotus/status");
    expect(settings.hostname).toBe("0.0.0.0");
    expect(settings.http?.port).toBe(0);
    expect(settings.oneBot?.port).toBe(25360);
  });
});

test("旧配置路径可发布地址，默认仍使用TRSS内网监听", async () => {
  await withConfig(async (root, writeConfig) => {
    expect((await readServerSettings(root, {})).publicUrl).toBeUndefined();
    await writeConfig("url: http://[::1]:2536/@lotus\n", true);
    const settings = await readServerSettings(root, {});
    expect(settings.publicUrl?.href).toBe("http://[::1]:2536/@lotus/");
    expect(settings.http?.port).toBe(2536);
    expect(settings.oneBot?.port).toBe(2536);

    await writeConfig("url:\nport: 8000\n");
    const primary = await readServerSettings(root, {});
    expect(primary.publicUrl).toBeUndefined();
    expect(primary.http?.port).toBe(8000);
    await writeConfig('url: "  "\nport: 8000\n');
    expect((await readServerSettings(root, {})).publicUrl).toBeUndefined();
  });
});

test("公共 HTTP 地址拒绝相对地址、认证信息、查询和片段", async () => {
  await withConfig(async (root, writeConfig) => {
    for (const url of [
      "/proxy/lotus", "//public.example/lotus", "https:///public.example/", "ftp://public.example/",
      "https://fixture-user:fixture-secret@public.example/", "https://@public.example/", "https://public.example/?",
      "https://public.example/#", "https://public.example/lotus?x=1", "https://public.example/lotus#section",
      "https://public.example\\lotus", "https://public.example/with space", 2536, { endpoint: "https://public.example" },
    ]) {
      await writeConfig(`url: ${JSON.stringify(url)}\n`);
      await expect(readServerSettings(root, {})).rejects.toThrow(
        "config/server.yaml 的 url 须为不含认证信息、查询参数或片段的 HTTP(S) 绝对地址。",
      );
    }
  });
});
