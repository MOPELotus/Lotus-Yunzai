import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfiguredOptionalProtocols, parseOptionalProtocolSettings, verifiedOptionalProtocolEntry } from "../lib/adapters/optional-protocol-config.ts";

test("optional protocols require deliberate selections and reject file/import overrides", () => {
  expect(parseOptionalProtocolSettings("satori", undefined)).toEqual([]);
  expect(parseOptionalProtocolSettings("satori", { enable: false })).toEqual([]);
  expect(parseOptionalProtocolSettings("satori", { enable: true, instances: { work: { platform: "discord" } } })).toEqual([
    { instance: "work", options: { platform: "discord" } },
  ]);
  expect(() => parseOptionalProtocolSettings("satori", {
    enable: true, entry: "/some/path", instances: { work: {} },
  })).toThrow("选装配置无效");
  expect(() => parseOptionalProtocolSettings("satori", {
    enable: true, instances: { "../borrowed": {} },
  })).toThrow("选装配置无效");
  expect(() => parseOptionalProtocolSettings("satori", {
    enable: true, instances: { work: { package: "other" } },
  })).toThrow("选装配置无效");
  expect(() => parseOptionalProtocolSettings("kook", {
    enable: true, instances: { work: { token: "invalid token" } },
  })).toThrow("选装配置无效");
  expect(parseOptionalProtocolSettings("kook", {
    enable: true, instances: { work: { token: "example", sendCardMessage: false } },
  })).toHaveLength(1);
});

async function fixture(use: (root: URL, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-optional-config-"));
  try {
    await use(pathToFileURL(directory + sep), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function digest(files: Record<string, string>) {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  return hash(JSON.stringify(Object.keys(files).sort().map(path => ({ path, sha256: hash(files[path]!) }))));
}

test("unconfigured and disabled deployments do nothing, and explicit selection needs a release pin", async () => {
  await fixture(async root => {
    expect(await loadConfiguredOptionalProtocols(root)).toEqual([]);
    await Bun.write(new URL("config/optional-protocols/satori.yaml", root), "enable: false\n");
    expect(await loadConfiguredOptionalProtocols(root)).toEqual([]);
    await Bun.write(new URL("config/optional-protocols/satori.yaml", root), "enable: true\ninstances: { work: {} }\n");
    await expect(loadConfiguredOptionalProtocols(root)).rejects.toThrow("缺少已验证的固定包");
    await expect(loadConfiguredOptionalProtocols(root, { satori: "c".repeat(64) })).rejects.toThrow("缺少已验证的固定包");
  });
});

test("a fixed entry must match package identity, the reviewed tree and an internal checked file", async () => {
  await fixture(async root => {
    const packageRoot = new URL("data/optional-protocols/satori/", root);
    const files = {
      "package.json": JSON.stringify({ name: "@lotus-yunzai/adapter-satori", exports: "./index.ts" }),
      "index.ts": 'throw new Error("resolving a package must not evaluate it");',
    };
    for (const [file, contents] of Object.entries(files)) await Bun.write(new URL(file, packageRoot), contents);
    expect((await verifiedOptionalProtocolEntry(root, "satori", digest(files))).href).toBe(new URL("index.ts", packageRoot).href);

    await Bun.write(new URL("index.ts", packageRoot), "export {};");
    await expect(verifiedOptionalProtocolEntry(root, "satori", digest(files))).rejects.toThrow("缺少已验证的固定包");
    await Bun.write(new URL("index.ts", packageRoot), files["index.ts"]);

    const escapedManifest = JSON.stringify({ name: "@lotus-yunzai/adapter-satori", exports: "./../index.ts" });
    await Bun.write(new URL("package.json", packageRoot), escapedManifest);
    await expect(verifiedOptionalProtocolEntry(root, "satori", digest({ ...files, "package.json": escapedManifest }))).rejects
      .toThrow("缺少已验证的固定包");
    const differentPackage = JSON.stringify({ name: "@lotus-yunzai/adapter-kook", exports: "./index.ts" });
    await Bun.write(new URL("package.json", packageRoot), differentPackage);
    await expect(verifiedOptionalProtocolEntry(root, "satori", digest({ ...files, "package.json": differentPackage }))).rejects
      .toThrow("缺少已验证的固定包");

    await Bun.write(new URL("package.json", packageRoot), files["package.json"]);
    await rm(new URL("index.ts", packageRoot));
    const outside = new URL("other.ts", root);
    await Bun.write(outside, files["index.ts"]);
    await symlink(outside.pathname, new URL("index.ts", packageRoot));
    await expect(verifiedOptionalProtocolEntry(root, "satori", digest(files))).rejects.toThrow("缺少已验证的固定包");
  });
});
