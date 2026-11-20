import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readServerSettings } from "../lib/server.ts";
import { activateUpdate } from "../lib/update-activation.ts";
import { readManagedHttpsPaths, verifyMovedHttpsPaths } from "../lib/update-https-paths.ts";

async function fixture(run: (base: string, root: string, rootUrl: URL) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), "lotus-update-https-"));
  const root = join(base, "active");
  try {
    await mkdir(root);
    await run(base, root, pathToFileURL(root + sep));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("HTTPS update paths use the active server YAML and keep in-tree symlink targets", () =>
  fixture(async (base, root, rootUrl) => {
    const outside = join(base, "outside.pem");
    const key = join(root, "credentials", "key.pem");
    const oldConfig = join(root, "config", "config", "server.yaml");
    await Bun.write(outside, "external certificate");
    await Bun.write(key, "key");
    await Bun.write(join(root, "credentials", "chain.pem"), "certificate");
    await mkdir(join(root, "config"), { recursive: true });
    await symlink("../credentials/chain.pem", join(root, "config", "cert.pem"));
    await Bun.write(oldConfig, Bun.YAML.stringify({ https: { key, cert: "./config/cert.pem", port: 44443 } }));
    expect(await readManagedHttpsPaths(rootUrl)).toEqual(["credentials/key.pem", "credentials/chain.pem"]);
    expect((await readServerSettings(rootUrl, {})).https).toMatchObject({ key, cert: "./config/cert.pem", port: 44443 });

    const main = join(root, "config", "server.yaml");
    await Bun.write(main, Bun.YAML.stringify({ https: { key, cert: outside } }));
    expect(await readManagedHttpsPaths(rootUrl)).toEqual(["credentials/key.pem"]);
    await Bun.write(main, Bun.YAML.stringify({ https: { key: "credentials", cert: "credentials/key.pem/absent" } }));
    expect(await readManagedHttpsPaths(rootUrl)).toEqual([]);
    await Bun.write(main, Bun.YAML.stringify({ https: false }));
    expect(await readManagedHttpsPaths(rootUrl)).toEqual([]);
  }));

test("HTTPS files follow the held worker and reject a candidate occupying the key", () =>
  fixture(async (base, root, rootUrl) => {
    const next = join(base, "next");
    const key = "credentials/key.pem";
    const cert = join(base, "outside.pem");
    await Bun.write(join(root, "config", "server.yaml"), Bun.YAML.stringify({ https: { key, cert } }));
    await Bun.write(join(root, key), "original");
    await Bun.write(cert, "external");
    await Bun.write(join(next, key), "candidate");
    const paths = await readManagedHttpsPaths(rootUrl);
    let held = false;
    await expect(activateUpdate(root, next, async () => { held = true; }, paths)).rejects.toThrow("候选目录占用");
    expect(held).toBe(false);
    expect(await Bun.file(join(root, key)).text()).toBe("original");
    await rm(dirname(join(next, key)), { recursive: true });

    const activation = await activateUpdate(root, next, async (active) => {
      expect(await Bun.file(join(active, key)).text()).toBe("original");
      expect(await Bun.file(cert).text()).toBe("external");
    }, paths);
    const settings = await readServerSettings(rootUrl, {});
    await verifyMovedHttpsPaths(root, activation.previous, settings.https);
    expect(await Bun.file(join(activation.previous, key)).exists()).toBe(false);
    await Bun.write(join(activation.previous, key), "unmoved old key");
    await expect(verifyMovedHttpsPaths(root, activation.previous, settings.https)).rejects.toThrow("HTTPS 证书或私钥");
  }));

test("HTTPS held startup refuses archived credentials reached through a symbolic parent", () =>
  fixture(async (base, root, rootUrl) => {
    const previous = join(base, "previous");
    const key = "tls/key.pem";
    const cert = join(base, "external.pem");
    await Bun.write(join(root, "config", "server.yaml"), Bun.YAML.stringify({ https: { key, cert } }));
    const settings = await readServerSettings(rootUrl, {});
    await mkdir(previous);
    await symlink(join(root, "real-tls"), join(previous, "tls"));
    await Bun.write(join(previous, "real-tls", "key.pem"), "old key behind absolute directory alias");
    await expect(verifyMovedHttpsPaths(root, previous, settings.https)).rejects.toThrow("HTTPS 证书或私钥");

    await rm(join(previous, "real-tls"), { recursive: true });
    await verifyMovedHttpsPaths(root, previous, settings.https);

    await Bun.write(join(root, "real-tls", "key.pem"), "active key behind directory alias");
    await symlink(join(root, "real-tls"), join(root, "tls"));
    const next = join(base, "next");
    await mkdir(next);
    const paths = await readManagedHttpsPaths(rootUrl);
    expect(paths).toEqual(["tls/key.pem", "real-tls/key.pem"]);
    await expect(activateUpdate(root, next, async () => {}, paths)).rejects.toThrow();
    expect(await Bun.file(join(root, key)).text()).toBe("active key behind directory alias");
  }));
