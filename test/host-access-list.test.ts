import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hostAccessListCommand } from "../lib/host-access-list.ts";
import { persistMaster, updateHostAccessList } from "../lib/master-config.ts";

test("匹配旧黑白用户及群名单入口，拒绝歧义目标", () => {
  const match = (msg: string, source: Record<string, unknown> = {}) =>
    hostAccessListCommand({ msg, message: msg, message_type: "private", self_id: 10, ...source });
  expect(match("#拉黑123")).toMatchObject({ key: "blackUser", target: 123, remove: false });
  expect(match("#取消拉白 321")).toMatchObject({ key: "whiteUser", target: 321, remove: true });
  expect(match("#移除拉黑群聊 456")).toMatchObject({ key: "blackGroup", target: 456, remove: true });
  expect(match("#删除拉白群", { message_type: "group", group_id: 64 }))
    .toMatchObject({ key: "whiteGroup", target: 64, currentGroup: true, remove: true });
  expect(match("#拉黑", { message_type: "group", message: [{ type: "at", qq: "10" }, { type: "at", qq: "23" }] })?.target).toBe(23);
  for (const target of ["24 25", "1e4", "0", "9007199254740992", "-3"]) {
    expect(match(`#拉黑 ${target}`)?.target).toBeUndefined();
  }
  expect(match("#拉黑群")?.target).toBeUndefined();
  expect(match("#群管加黑 123")).toBeUndefined();
});

test("名单变更与主人授权共用锁，按原路径精确更新并核对有效主人", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-access-yaml-"));
  const root = pathToFileURL(`${directory}/`);
  const old = join(directory, "config/config/other.yaml");
  const current = join(directory, "config/other.yaml");
  const actor = { botId: 10, userId: 20 };
  const active = () => true;
  await mkdir(join(directory, "config/config"), { recursive: true });
  const source = [
    "---", '# 主人配置', 'master: ["10:20", "11:21"]  # 主人', "masterQQ: 22",
    'blackUser:', '    - 33 # 保留原因', '    - "0044"', '    - 44', 'blackGroup: 55 # 单一群',
    'disablePrivate:    true', 'unknown: {enabled:   true}', '... # 文件末尾', "",
  ].join("\r\n");
  try {
    await writeFile(old, source);
    for (const owner of [20, 21, 22]) {
      expect(await updateHostAccessList(root, "blackUser", owner, false, actor, active)).toBe("protected");
    }
    expect(await updateHostAccessList(root, "blackUser", 44, true, actor, active)).toBe("removed");
    expect(await updateHostAccessList(root, "blackGroup", 55, true, actor, active)).toBe("removed");
    expect(await updateHostAccessList(root, "whiteGroup", 65, false, actor, active)).toBe("added");
    expect(await readFile(old, "utf8")).toBe(source
      .replace('    - "0044"\r\n    - 44\r\n', "")
      .replace("blackGroup: 55 #", "blackGroup: [] #")
      .replace("... #", "whiteGroup: [ 65 ]\r\n... #"));
    await expect(updateHostAccessList(root, "whiteUser", 26, false, { ...actor, botId: 11 }, active)).rejects.toThrow("未获得");
    let calls = 0;
    await expect(updateHostAccessList(root, "whiteUser", 26, false, actor, () => ++calls === 1)).rejects.toThrow("会话已失效");
    expect(await Bun.file(current).exists()).toBe(false);
    const before = await readFile(old, "utf8");
    await writeFile(current, 'master: ["10:20"]\nwhiteUser: 25\n');
    await Promise.all([
      updateHostAccessList(root, "whiteUser", 26, false, actor, active),
      updateHostAccessList(root, "whiteUser", 27, false, actor, active),
      persistMaster(root, 10, 24, 20, active),
    ]);
    const result = Bun.YAML.parse(await readFile(current, "utf8")) as Record<string, unknown>;
    expect(result.master).toEqual(["10:20", "10:24"]);
    expect(new Set(result.whiteUser as number[])).toEqual(new Set([25, 26, 27]));
    expect(await readFile(old, "utf8")).toBe(before);
    await writeFile(current, '{master: ["10:20"], x:   true} # 旧式行内\n');
    await updateHostAccessList(root, "whiteUser", 25, false, actor, active);
    expect(await readFile(current, "utf8")).toBe('{whiteUser: [ 25 ], master: ["10:20"], x:   true} # 旧式行内\n');
    await writeFile(current, 'master: ["10:20"]\nwhiteUser: # 留空\n');
    await updateHostAccessList(root, "whiteUser", 25, false, actor, active);
    expect(await readFile(current, "utf8")).toBe('master: ["10:20"]\nwhiteUser: [ 25 ] # 留空\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
