import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

function legacyScript(command: string, version: string, relativeImport = false) {
  return `
    ${relativeImport ? 'import { suffix } from "./helper.mjs";' : 'const suffix = "";'}
    export default class extends plugin {
      constructor() {
        super({ rule: [{ reg: ${JSON.stringify(`^${command}$`)}, fnc: "answer" }] });
      }
      answer() { return this.reply(${JSON.stringify(version)} + suffix); }
    }
  `;
}

function modernScript(version: string) {
  return `
    export default { commands: {
      "#现代脚本": () => ${JSON.stringify(version)},
      "#重载探针": (argument) => "reload-probe:" + argument,
    }};
  `;
}

async function setup(root: string, fileWatch?: false) {
  await copyHost(root);
  const plugins = join(root, "plugins");
  await Promise.all(["hot/apps", "indexed", "modern"].map((path) => mkdir(join(plugins, path), { recursive: true })));
  if (fileWatch === false) {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config/bot.yaml"), "file_watch: false\n");
  }
  await Promise.all([
    writeFile(join(plugins, "hot/live.js"), legacyScript("#被监听脚本", "fixture-live-v1", true)),
    writeFile(join(plugins, "hot/helper.mjs"), 'export const suffix = ":helper";'),
    writeFile(join(plugins, "hot/apps/nested.js"), legacyScript("#子目录脚本", "fixture-nested-v1")),
    writeFile(join(plugins, "indexed/index.js"), legacyScript("#入口脚本", "fixture-index-v1")),
    writeFile(join(plugins, "modern/package.json"), JSON.stringify({
      name: "reload-modern-fixture", type: "module", lotusYunzai: { entry: "./index.js" },
    })),
    writeFile(join(plugins, "modern/index.js"), modernScript("fixture-modern-v1")),
  ]);
  return plugins;
}

async function atomicWrite(path: string, content: string) {
  const staged = `${path}.fixture-tmp`;
  await writeFile(staged, content);
  await rename(staged, path);
}

function observe(stream: ReadableStream<Uint8Array>) {
  const lines: string[] = [];
  let changed = Promise.withResolvers<void>();
  let ended = false;
  function notify() {
    changed.resolve();
    changed = Promise.withResolvers<void>();
  }
  const finished = (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        const pieces = pending.split("\n");
        pending = pieces.pop() ?? "";
        if (pieces.length) {
          lines.push(...pieces.map((line) => line.replace(/\r$/u, "")));
          notify();
        }
      }
      pending += decoder.decode();
      if (pending) lines.push(pending);
    } finally {
      reader.releaseLock();
      ended = true;
      notify();
    }
  })();
  async function until(pattern: RegExp, begin = 0, timeout = 2_000): Promise<number> {
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(() => deadline.reject(new Error(
      `未收到 ${pattern.source}。最近输出：\n${lines.slice(-15).join("\n")}`,
    )), timeout);
    try {
      for (;;) {
        const position = lines.findIndex((line, index) => index >= begin && pattern.test(line));
        if (position >= 0) return position;
        if (ended) throw new Error(`宿主提前结束。\n${lines.slice(-15).join("\n")}`);
        await Promise.race([changed.promise, deadline.promise]);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return { lines, finished, until };
}

function start(root: string) {
  const host = Bun.spawn([process.execPath, "app.ts"], {
    cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH, TZ: "UTC", LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0" },
  });
  const output = observe(host.stdout);
  const errors = observe(host.stderr);
  let probes = 0;
  return {
    output, errors,
    started: () => output.until(/Lotus-Yunzai 已启动/u, 0, 6_000),
    async probe(...commands: string[]) {
      const begin = output.lines.length;
      const probe = ++probes;
      host.stdin.write(`${commands.join("\n")}\n#重载探针 ${probe}\n`);
      host.stdin.flush();
      const end = await output.until(new RegExp(`^reload-probe:${probe}$`, "u"), begin);
      return output.lines.slice(begin, end).filter((line) => line.startsWith("fixture-"));
    },
    async stop() {
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGTERM");
      const timer = setTimeout(() => host.kill("SIGKILL"), 2_000);
      try {
        await host.exited;
        await Promise.all([output.finished, errors.finished]);
      } finally {
        clearTimeout(timer);
        host.stdin.end();
      }
    },
  };
}

test("默认文件监听热更新独立旧插件，失败保留原版且配置关闭时不生效", async () => {
  const defaultRoot = await mkdtemp(join(tmpdir(), "lotus-trss-watch-default-"));
  const disabledRoot = await mkdtemp(join(tmpdir(), "lotus-trss-watch-disabled-"));
  let active: ReturnType<typeof start> | undefined;
  let disabled: ReturnType<typeof start> | undefined;
  const commands = ["#被监听脚本", "#子目录脚本", "#入口脚本", "#现代脚本"];
  const versions = ["fixture-live-v1:helper", "fixture-nested-v1", "fixture-index-v1", "fixture-modern-v1"];
  try {
    const [plugins, disabledPlugins] = await Promise.all([setup(defaultRoot), setup(disabledRoot, false)]);
    active = start(defaultRoot);
    disabled = start(disabledRoot);
    await Promise.all([active.started(), disabled.started()]);
    expect(await active.probe(...commands)).toEqual(versions);
    expect(await disabled.probe(...commands)).toEqual(versions);

    const live = join(plugins, "hot/live.js");
    const replaceFrom = active.output.lines.length;
    await Promise.all([
      atomicWrite(live, legacyScript("#被监听脚本", "fixture-live-v2", true)),
      atomicWrite(join(plugins, "hot/apps/nested.js"), legacyScript("#子目录脚本", "fixture-nested-v2")),
      atomicWrite(join(plugins, "indexed/index.js"), legacyScript("#入口脚本", "fixture-index-v2")),
      atomicWrite(join(plugins, "modern/index.js"), modernScript("fixture-modern-v2")),
      atomicWrite(join(disabledPlugins, "hot/live.js"), legacyScript("#被监听脚本", "fixture-live-v2", true)),
    ]);
    // A terminal probe before the default five-second debounce still sees the old command.
    await Bun.sleep(1_000);
    expect(await active.probe("#被监听脚本")).toEqual(["fixture-live-v1:helper"]);
    await active.output.until(/\[插件\] 已热更新 (?:plugins\/)?hot\/live\.js。/u, replaceFrom, 8_000);
    const reloaded = ["fixture-live-v2:helper", ...versions.slice(1)];
    expect(await active.probe(...commands)).toEqual(reloaded);
    expect(await disabled.probe(...commands)).toEqual(versions);

    const failureFrom = active.errors.lines.length;
    await atomicWrite(live, "export default class extends plugin {");
    await active.errors.until(/\[插件\] 热更新 (?:plugins\/)?hot\/live\.js 失败：/u, failureFrom, 9_000);
    expect(await active.probe(...commands)).toEqual(reloaded);

    const additionFrom = active.output.lines.length;
    await rm(live);
    await Promise.all([plugins, disabledPlugins].map((root) =>
      atomicWrite(join(root, "hot/new.js"), legacyScript("#新增脚本", "fixture-new-v1"))));
    await active.output.until(/\[插件\] 已热更新 (?:plugins\/)?hot\/new\.js。/u, additionFrom, 9_000);
    expect(await active.probe(...commands, "#新增脚本")).toEqual([...versions.slice(1), "fixture-new-v1"]);
    expect(await disabled.probe(...commands, "#新增脚本")).toEqual(versions);
  } finally {
    await Promise.all([active?.stop(), disabled?.stop()]);
    await Promise.all([defaultRoot, disabledRoot].map((root) => rm(root, { recursive: true, force: true })));
  }
}, 45_000);
