import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export function disableMemberPrewarm(root: string) {
  const primary = join(root, "config", "bot.yaml");
  const config = existsSync(primary) ? primary : join(root, "config", "config", "bot.yaml");
  mkdirSync(dirname(config), { recursive: true });
  if (!existsSync(config) || !/^cache_group_member\s*:/mu.test(readFileSync(config, "utf8"))) {
    appendFileSync(config, "\ncache_group_member: false\n");
  }
}

/** Keep the checkout directory real while sharing immutable workspace sources with isolated hosts. */
export async function linkHostPackages(root: string) {
  const target = join(root, "packages");
  await mkdir(target, { recursive: true });
  for (const child of await readdir(join(import.meta.dir, "../packages"), { withFileTypes: true })) {
    if (!child.isDirectory() || existsSync(join(target, child.name))) continue;
    await symlink(join(import.meta.dir, "../packages", child.name), join(target, child.name), "dir");
  }
}

/** Opt rendering fixtures into an initialized deployment's repository-owned bundle. */
export async function linkHostBuiltinResources(root: string) {
  await mkdir(join(root, "resources"), { recursive: true });
  await symlink(join(import.meta.dir, "../resources/builtin"), join(root, "resources/builtin"), "dir");
}

export async function copyHost(root: string) {
  await cp(new URL("../lib", import.meta.url), join(root, "lib"), { recursive: true });
  await cp(new URL("../i18n", import.meta.url), join(root, "i18n"), { recursive: true });
  await linkHostPackages(root);
  // Keep test listeners on loopback unless a case explicitly selects another bind address.
  const hostSource = await Bun.file(new URL("../app.ts", import.meta.url)).text();
  // Protocol/plugin cases configure storage explicitly; the managed service has real isolated lifecycle tests.
  const fixture = hostSource.replace('(await ensureManagedValkey(root, { signal: lifecycle.signal })).connection',
    'await readStorageConnection(root, Bun.env.LOTUS_VALKEY_URL)');
  await Bun.write(join(root, "app.ts"), 'process.env.LOTUS_LISTEN_HOST ??= "127.0.0.1";\n' + fixture);
  await symlink(join(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir");
  const system = join(root, "plugins", "system");
  const source = join(import.meta.dir, "../plugins/system");
  await mkdir(system, { recursive: true });
  const sources = new Bun.Glob("*.ts").scanSync(source);
  for (const file of ["package.json", ...sources]) {
    if (!file.endsWith(".test.ts")) await cp(join(source, file), join(system, file));
  }
  await cp(join(source, "i18n"), join(system, "i18n"), { recursive: true });
  const dependencies = join(source, "node_modules");
  if (existsSync(dependencies)) await symlink(dependencies, join(system, "node_modules"), "dir");
}
