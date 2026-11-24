import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { cp, mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export function disableMemberPrewarm(root: string) {
  const primary = join(root, "config", "bot.yaml");
  const config = existsSync(primary) ? primary : join(root, "config", "config", "bot.yaml");
  mkdirSync(dirname(config), { recursive: true });
  if (!existsSync(config) || !/^cache_group_member\s*:/mu.test(readFileSync(config, "utf8"))) {
    appendFileSync(config, "\ncache_group_member: false\n");
  }
}

export async function copyHost(root: string) {
  await cp(new URL("../lib", import.meta.url), join(root, "lib"), { recursive: true });
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
  const dependencies = join(source, "node_modules");
  if (existsSync(dependencies)) await symlink(dependencies, join(system, "node_modules"), "dir");
}
