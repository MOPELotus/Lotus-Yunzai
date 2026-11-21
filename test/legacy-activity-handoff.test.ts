import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const script = fileURLToPath(new URL("../scripts/prepare-legacy-activity-notices.ts", import.meta.url));
const source = `# 公告与活动原配置
pushTime: "0 0/5 * * * ?"
gsannounceGroup: &ann
  "99": [7719] # 原神公告
srinfoGroup: *ann
zzzannounceGroup: { "102": [7739] } # 绝区零公告保持
gsActivityPush: # 保留活动说明
  "99": [7701, 7702] # 原神活动分组
  "101": ["7711"]
srActivityPush:
  "99": [7702, 7703]
banWord: { sr: "自定义词" }
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lotus-activity-handoff-"));
  const yaml = join(root, "snapshot.yaml");
  const gs = join(root, "genshin.json");
  const sr = join(root, "starrail.json");
  const output = join(root, "output");
  await mkdir(output);
  await Promise.all([writeFile(yaml, source), writeFile(gs, "{}"), writeFile(sr, "{}")]);
  async function invoke(...flags: string[]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", script, ...flags, yaml, gs, sr], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 3_000,
    });
    const [code, stdout, error] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, error };
  }
  return { root, yaml, gs, sr, output, invoke };
}

test("活动到期交还只合并两份离线开关，保留原路径、公告字段、注释及旧群号类型", async () => {
  const f = await fixture();
  try {
    await Promise.all([writeFile(f.gs, '{"99:7701":"off","101:7712":"on"}'), writeFile(f.sr, '{"99:7703":"off"}')]);
    const preview = await f.invoke();
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toEqual({ mode: "dry-run", counts: { gs: 3, sr: 1 }, changed: ["gs", "sr"], written: false });
    expect(await readdir(f.output)).toEqual([]);
    const [one, two] = await Promise.all([f.invoke("--export", f.output), f.invoke("--export", f.output)]);
    expect([one.code, two.code]).toEqual([0, 0]);
    const results = [one, two].map(({ stdout }) => JSON.parse(stdout));
    expect(results.map(({ written }) => written).sort()).toEqual([false, true]);
    expect(results[0].path).toBe(results[1].path);
    const saved = await readFile(results[0].path, "utf8");
    expect(YAML.parse(saved)).toEqual({ ...YAML.parse(source),
      gsActivityPush: { "99": [7702], "101": ["7711", 7712] },
      srActivityPush: { "99": [7702] },
    });
    for (const comment of ["# 公告与活动原配置", "# 原神公告", "# 绝区零公告保持", "# 保留活动说明", "# 原神活动分组"]) {
      expect(saved).toContain(comment);
    }
    expect(saved).toContain("srinfoGroup: *ann");
    expect(await readFile(f.yaml, "utf8")).toBe(source);
    const repeated = await f.invoke("--export", f.output);
    expect(JSON.parse(repeated.stdout).written).toBe(false);
    await writeFile(results[0].path, "人工文件");
    const conflict = await f.invoke("--export", f.output);
    expect(conflict.code).toBe(1);
    expect(await readFile(results[0].path, "utf8")).toBe("人工文件");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("拒绝旧共享队列无法表示的范围、无效快照与会改变其它配置的锚点", async () => {
  const f = await fixture();
  try {
    expect((await f.invoke()).error).toContain("旧版共用到期队列无法保留");
    await writeFile(f.gs, '["99:7701","off"]');
    expect((await f.invoke()).error).toContain("HGETALL 的 JSON 对象");
    await writeFile(f.gs, '{"99:7701":"disabled"}');
    expect((await f.invoke()).error).toContain("无效的账号、群号或状态");
    await writeFile(f.gs, '{"99:7701":"off"}');
    await writeFile(f.yaml, 'gsActivityPush: &shared { "99": [7701, 7702] }\ngsannounceGroup: *shared\n');
    expect((await f.invoke("--export", f.output)).error).toContain("引用或其它配置无法安全保留");
    expect(await readdir(f.output)).toEqual([]);
    const unchanged = 'gsActivityPush: { "99": [7702] } # 已是旧格式\r\n';
    await writeFile(f.yaml, unchanged);
    const identical = await f.invoke("--export", f.output);
    expect(identical.code).toBe(0);
    const result = JSON.parse(identical.stdout);
    expect(result.changed).toEqual([]);
    expect(await readFile(result.path, "utf8")).toBe(unchanged);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
