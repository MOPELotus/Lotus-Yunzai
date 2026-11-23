import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelRemoteSettings } from "../lib/panel-remote-settings.ts";
import { readRemoteSettings } from "../lib/remote-control.ts";
import { rotateRemoteOtp } from "../lib/remote-otp.ts";

test.skipIf(process.platform !== "linux")("面板仅在本机配对后开启远程运维，原子保存并检查旧页面", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-remote-"));
  const root = pathToFileURL(directory + "/");
  const panel = panelRemoteSettings(root);
  const url = "http://panel.invalid/native/remote";
  const get = () => panel(new Request(url), () => true).then(response => response.json());
  const put = (previous: unknown, values: unknown, allowed = () => true) => panel(new Request(url, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previous, values }),
  }), allowed);
  try {
    await mkdir(join(directory, "config"));
    const configuration = join(directory, "config", "remote.yaml");
    await writeFile(configuration, "# 本机注释\nlocal_marker: keep\n");
    const first = await get();
    expect(first.values).toMatchObject({ paired: false, enabled: false, timeout: 30_000, shells: ["bash", "sh", "zsh"] });
    expect(first.fields.find((field: { key: string }) => field.key === "enabled").readonly).toBe(true);
    expect((await put(first.values, { ...first.values, enabled: true })).status).toBe(403);
    const uri = rotateRemoteOtp(directory, false);
    const secret = new URL(uri).searchParams.get("secret")!;
    const paired = await get();
    expect(paired.values.paired).toBe(true);
    expect(JSON.stringify(paired)).not.toContain(secret);
    expect((await put(paired.values, { ...paired.values, shells: ["/tmp/invalid"] })).status).toBe(400);
    expect((await put(paired.values, { ...paired.values, enabled: true }, () => false)).status).toBe(401);
    const changed = { ...paired.values, enabled: true, timeout: 7_000, shells: ["sh"], overwrite: true };
    expect((await put(paired.values, changed)).status).toBe(200);
    expect(readRemoteSettings(directory)).toEqual({ enabled: true, timeout: 7_000, shells: ["sh"], overwrite: true, allowAdmin: false });
    expect(await readFile(configuration, "utf8")).toContain("# 本机注释\nlocal_marker: keep");
    expect((await put(paired.values, { ...changed, timeout: 900 })).status).toBe(409);
    await rm(join(directory, "data", "remote-auth"), { recursive: true });
    expect((await put(changed, { ...changed, enabled: false })).status).toBe(200);
    expect((await get()).values).toMatchObject({ enabled: false, paired: false, timeout: 7_000 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
