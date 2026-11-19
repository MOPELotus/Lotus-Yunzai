import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { persistMaster } from "../lib/master-config.ts";
import { readMasterPermissions } from "../lib/permissions.ts";

const lockName = ".other.yaml.lotus-master.sqlite";

async function fixture(run: (root: URL, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-master-config-"));
  try {
    await run(pathToFileURL(`${directory}/`), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function setup(directory: string, text: string, legacy = false) {
  const file = join(directory, legacy ? "config/config/other.yaml" : "config/other.yaml");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

test("写入当前生效配置，原子追加两种绑定并保留 YAML 注释、未知字段、权限与幂等性", () => fixture(async (root, directory) => {
  const legacyBytes = 'master: ["10:20"]\nignore: true\n';
  const legacy = await setup(directory, legacyBytes, true);
  const flat = await setup(directory, `# 配置文件
master:  # 精确授权
  - "10:20" # 旧主人
masterQQ: ["stdin", "0020"] # 旧豁免
unknown: &unknown {feature: true}
settings: *unknown
`);
  await chmod(flat, 0o640);
  const source = await stat(flat);
  const result = await persistMaster(root, 10, 21, 20);
  expect(result).toEqual({ master: ["10:20", "10:21"], masterQQ: ["stdin", "0020", 21],
    unknown: { feature: true }, settings: { feature: true } });
  const bytes = await readFile(flat, "utf8");
  for (const comment of ["# 配置文件", "# 精确授权", "# 旧主人", "# 旧豁免", "&unknown", "*unknown"]) {
    expect(bytes).toContain(comment);
  }
  const updated = await stat(flat);
  expect(updated.mode & 0o777).toBe(0o640);
  expect([updated.uid, updated.gid]).toEqual([source.uid, source.gid]);
  expect(await readFile(legacy, "utf8")).toBe(legacyBytes);
  expect(await persistMaster(root, 10, 21, 20)).toEqual(result);
  expect(await readFile(flat, "utf8")).toBe(bytes);
  expect((await readdir(dirname(flat))).sort()).toEqual([lockName, "config", "other.yaml"]);
}));

test("只有当前机器人主人或已明确配置的本机 stdin 才可审批", () => fixture(async (root, directory) => {
  await expect(persistMaster(root, 10, 21, "stdin")).rejects.toThrow("请先在本机配置");
  expect(await readdir(directory)).toEqual([]);
  const text = 'master: ["11:20"]\nmasterQQ: [20]\n';
  const file = await setup(directory, text, true);
  await mkdir(join(directory, "config/other.yaml"));
  await expect(persistMaster(root, 10, 21, "stdin")).rejects.toThrow("未获得");
  await expect(persistMaster(root, 10, 21, 20)).rejects.toThrow("未获得");
  await expect(persistMaster(root, 10, 2.5, 20)).rejects.toThrow("有效");
  expect(await readFile(file, "utf8")).toBe(text);
  await writeFile(file, 'master: "stdin:stdin" # 本机授权\nmasterQQ: "21" # 既有豁免\n');
  const result = await persistMaster(root, 10, 21, "stdin");
  expect(result).toEqual({ master: ["stdin:stdin", "10:21"], masterQQ: "21" });
  const written = await readFile(file, "utf8");
  expect(written).toContain("# 本机授权");
  expect(written).toContain("# 既有豁免");
}));

test("机器人账号清单仅包含有效的显式账号绑定，随授权实时刷新", () => fixture(async (root, directory) => {
  await setup(directory, `master: ["99:42", "12:43", "99:44", "stdin:stdin", "9007199254740992:45"]
masterQQ: [987]
`);
  const permissions = await readMasterPermissions(root);
  expect(permissions.botIds()).toEqual([12, 99]);
  expect(await permissions.grant(98, 46, 42)).toBe(false);
  expect(permissions.botIds()).toEqual([12, 99]);
  expect(await permissions.grant(98, 46, "stdin")).toBe(true);
  expect(permissions.botIds()).toEqual([12, 98, 99]);
}));

test("跟随配置符号链接并保留链接本身，多个授权并发时不会丢失", () => fixture(async (root, directory) => {
  const target = join(directory, "managed-other.yaml");
  const symbolic = join(directory, "config/other.yaml");
  await writeFile(target, 'master: ["10:20"]\nmeta: unchanged\n');
  await mkdir(dirname(symbolic));
  await symlink("../managed-other.yaml", symbolic);

  await Promise.all([persistMaster(root, 10, 21, 20), persistMaster(root, 10, 22, 20)]);
  expect((await lstat(symbolic)).isSymbolicLink()).toBe(true);
  expect(await readlink(symbolic)).toBe("../managed-other.yaml");
  const output = Bun.YAML.parse(await readFile(target, "utf8"));
  expect(output).toEqual({ master: ["10:20", expect.any(String), expect.any(String)],
    masterQQ: [expect.any(Number), expect.any(Number)], meta: "unchanged" });
  expect(new Set((output as { master: string[] }).master)).toEqual(new Set(["10:20", "10:21", "10:22"]));
  expect(new Set((output as { masterQQ: number[] }).masterQQ)).toEqual(new Set([21, 22]));
  expect((await readdir(directory)).sort()).toEqual([".managed-other.yaml.lotus-master.sqlite", "config", "managed-other.yaml"]);
}));

test("共享锚点会改变其他字段时拒绝写入，格式错误也保持原文件", () => fixture(async (root, directory) => {
  const shared = 'master: &owners ["10:20"]\ncustom: *owners\n';
  const file = await setup(directory, shared);
  await expect(persistMaster(root, 10, 21, 20)).rejects.toThrow("其他 YAML 字段或引用");
  expect(await readFile(file, "utf8")).toBe(shared);
  const invalid = 'master: ["10:20"]\nmaster: ["10:21"]\n';
  await writeFile(file, invalid);
  await expect(persistMaster(root, 10, 21, 20)).rejects.toThrow("YAML 无效");
  expect(await readFile(file, "utf8")).toBe(invalid);
  expect((await readdir(dirname(file))).sort()).toEqual([lockName, "other.yaml"]);
}));

test("已有配置锁等待期间撤回审批权限时，重新读到授权变化", () => fixture(async (root, directory) => {
  const file = await setup(directory, 'master: ["10:20"]\n');
  const lock = new Database(join(dirname(file), lockName));
  const updated = 'master: ["10:33"]\n';
  try {
    lock.exec("BEGIN IMMEDIATE");
    const pending = persistMaster(root, 10, 21, 20);
    void pending.catch(() => undefined);
    await Bun.sleep(40);
    await writeFile(file, updated);
    lock.exec("ROLLBACK");
    await expect(pending).rejects.toThrow("未获得");
    expect(await readFile(file, "utf8")).toBe(updated);
  } finally {
    lock.close();
  }
}));

test("等待主人配置锁期间会话失效，不更新文件或在线权限", () => fixture(async (root, directory) => {
  const original = 'master: ["10:20"]\nmasterQQ: [20]\n';
  const file = await setup(directory, original);
  const permissions = await readMasterPermissions(root);
  const lock = new Database(join(dirname(file), lockName));
  let current = true;
  try {
    lock.exec("BEGIN IMMEDIATE");
    const pending = permissions.grant(10, 21, 20, () => current);
    await Bun.sleep(40);
    current = false;
    lock.exec("ROLLBACK");
    expect(await pending).toBe(false);
    expect(permissions.isMaster(10, 21)).toBe(false);
    expect(await readFile(file, "utf8")).toBe(original);
  } finally {
    lock.close();
  }
  current = true;
  expect(await permissions.grant(10, 21, 20, () => current)).toBe(true);
  expect(permissions.isMaster(10, 21)).toBe(true);
}));

test("替换配置前再次检查会话，已写入的主人也不能凭过期会话返回成功", () => fixture(async (root, directory) => {
  const original = 'master: ["10:20", "10:21"]\nmasterQQ: [20, 21]\n';
  const file = await setup(directory, original);
  await expect(persistMaster(root, 10, 21, 20, () => false)).rejects.toThrow("会话已失效");
  let checks = 0;
  await expect(persistMaster(root, 10, 22, 20, () => ++checks === 1)).rejects.toThrow("会话已失效");
  expect(checks).toBe(2);
  expect(await readFile(file, "utf8")).toBe(original);
  expect((await readdir(dirname(file))).sort()).toEqual([lockName, "other.yaml"]);
}));

test("持锁进程被终止后可继续写入同一个侧文件", () => fixture(async (root, directory) => {
  const file = await setup(directory, 'master: ["10:20"]\n');
  const sidecar = join(dirname(file), lockName);
  const child = Bun.spawn([process.execPath, "-e", `
    import { Database } from "bun:sqlite";
    const db = new Database(Bun.env.LOTUS_TEST_LOCK);
    db.exec("BEGIN IMMEDIATE");
    console.log("locked");
    setInterval(() => {}, 1000);
  `], { env: { LOTUS_TEST_LOCK: sidecar }, stdout: "pipe", stderr: "inherit" });
  try {
    const reader = child.stdout.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("locked\n");
    } finally {
      reader.releaseLock();
    }
    const original = await stat(sidecar);
    child.kill("SIGKILL");
    await child.exited;
    expect(await persistMaster(root, 10, 21, 20)).toEqual({ master: ["10:20", "10:21"], masterQQ: [21] });
    expect((await stat(sidecar)).ino).toBe(original.ino);
  } finally {
    child.kill();
    await child.exited;
  }
}));
