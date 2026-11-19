import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maxPluginLoadMs, parsePluginLoadMilliseconds, pluginProbeTokenEnvironment, readPluginLoading } from "../lib/plugin-load-progress.ts";
import { copyHost } from "./host-fixture.ts";

test("插件加载超时按秒取值并保证看门狗的计时范围", () => {
  expect(parsePluginLoadMilliseconds(undefined)).toBe(60_000);
  expect(parsePluginLoadMilliseconds("0.35")).toBe(350);
  expect(parsePluginLoadMilliseconds(0)).toBe(0);
  expect(parsePluginLoadMilliseconds(0.0001)).toBe(1);
  for (const value of [null, "", true, -1, "0x10", Infinity, (maxPluginLoadMs + 1) / 1_000]) {
    expect(parsePluginLoadMilliseconds(value)).toBeUndefined();
  }
});

async function modernPlugin(root: string, name: string, source: string) {
  const directory = join(root, "plugins", name);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, "package.json"), JSON.stringify({
      name, type: "module", lotusYunzai: { entry: "./index.ts" },
    })),
    writeFile(join(directory, "index.ts"), source),
  ]);
}

async function waitFor<T>(read: () => T | Promise<T>, accepts: (value: T) => boolean, description: string): Promise<T> {
  const deadline = performance.now() + 3_000;
  do {
    const value = await read();
    if (accepts(value)) return value;
    await Bun.sleep(10);
  } while (performance.now() < deadline);
  throw new Error(description);
}

test("加载超时后继续启动，迟到的现代工厂和 V3 初始化不会留下注册", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-plugin-load-timeout-"));
  try {
    await copyHost(root);
    await mkdir(join(root, "config"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "config/bot.yaml"), "plugin_load_timeout: 0.35\n"),
      writeFile(join(root, "fixture-events.txt"), ""),
      writeFile(join(root, "fixture.js"), `
        import { appendFileSync } from "node:fs";
        export const mark = (event) => appendFileSync(new URL("./fixture-events.txt", import.meta.url), event + "\\n");
        export async function waitForRelease() {
          while (!await Bun.file(new URL("./fixture-release", import.meta.url)).exists()) await Bun.sleep(10);
        }
      `),
      modernPlugin(root, "a-slow-modern", `
        import { mark, waitForRelease } from "../../fixture.js";
        export async function createModule({ signal }) {
          mark("modern-start");
          const resource = setInterval(() => {}, 60_000);
          await waitForRelease();
          mark("modern-finished:" + signal.aborted);
          return {
            commands: { "#迟到现代": () => { mark("modern-command"); return "不应执行现代指令"; } },
            dispose() { clearInterval(resource); mark("modern-cleanup"); },
          };
        }
      `),
      writeFile(join(root, "plugins/b-slow-legacy.js"), `
        import Handler from "../lib/plugins/handler.js";
        import { mark, waitForRelease } from "../fixture.js";
        export default class extends plugin {
          constructor() {
            super({
              rule: [{ reg: "^#迟到旧版$", fnc: "late" }],
              handler: [{ key: "fixture.timeout.declared", fn: "late" }],
              task: { name: "迟到任务", cron: "* * * * * *", fnc: "tick", log: false },
            });
          }
          async init() {
            mark("legacy-start");
            const resource = setInterval(() => {}, 60_000);
            this.addCleanup(() => { clearInterval(resource); mark("legacy-cleanup"); });
            Handler.add({ key: "fixture.timeout.early", fn: () => "不应保留" });
            await waitForRelease();
            const lateResource = setInterval(() => {}, 60_000);
            this.addCleanup(() => { clearInterval(lateResource); mark("legacy-late-cleanup"); });
            Handler.add({ key: "fixture.timeout.late", fn: () => "不应注册" });
            mark("legacy-finished");
          }
          late() { mark("legacy-command"); return this.reply("不应执行旧版指令"); }
          tick() { mark("legacy-task"); }
        }
      `),
      modernPlugin(root, "z-healthy", `
        import Handler from "../../lib/plugins/handler.js";
        import { mark } from "../../fixture.js";
        export function createModule({ signal }) {
          signal.addEventListener("abort", () => mark("healthy-signal-abort"), { once: true });
          return { commands: {
            "#超时检查": () => "fixture-probe " + JSON.stringify({
              aborted: signal.aborted,
              handlers: ["early", "late", "declared"].map((key) => Handler.has("fixture.timeout." + key)),
            }),
          } };
        }
        export const apps = { task: class extends plugin {
          constructor() { super({ task: { name: "存活任务", cron: "* * * * * *", fnc: "tick", log: false } }); }
          tick() { mark("healthy-task"); }
        } };
      `),
    ]);

    const token = crypto.randomUUID();
    const startup: number[] = [];
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, env: { PATH: process.env.PATH, [pluginProbeTokenEnvironment]: token },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      timeout: 8_000, killSignal: "SIGKILL",
      ipc(message: unknown) {
        const wait = readPluginLoading(message, token, startup.length + 1);
        if (wait !== undefined) startup.push(wait);
      },
    });
    const reader = host.stdout.getReader();
    const decoder = new TextDecoder();
    const stderr = new Response(host.stderr).text();
    const events = async () => (await readFile(join(root, "fixture-events.txt"), "utf8")).trim().split("\n");
    let unread = "";
    async function readOutput(pattern: RegExp) {
      while (true) {
        const match = pattern.exec(unread);
        if (match) {
          unread = unread.slice(match.index + match[0].length);
          return match;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`超时测试宿主未输出 ${pattern.source}。\n${unread}\n${await stderr}`);
        unread += decoder.decode(chunk.value, { stream: true });
      }
    }
    async function checkHealthyModule() {
      host.stdin.write("#迟到现代\n#迟到旧版\n#超时检查\n");
      host.stdin.flush();
      const result = await readOutput(/^fixture-probe ([^\n]+)\n/mu);
      expect(JSON.parse(result[1]!)).toEqual({ aborted: false, handlers: [false, false, false] });
    }

    try {
      await readOutput(/Lotus-Yunzai 已启动。/u);
      expect(await waitFor(() => [...startup], (values) => values.at(-1) === 0, "未收到插件加载进度。"))
        .toEqual([350, 350, 350, 350, 0]);
      const beforeRelease = await events();
      expect(beforeRelease.slice(0, 2)).toEqual(["modern-start", "legacy-start"]);
      expect(beforeRelease).not.toContain("legacy-finished");
      expect(beforeRelease.some((event) => event.startsWith("modern-finished:"))).toBe(false);
      await checkHealthyModule();

      await writeFile(join(root, "fixture-release"), "settle");
      const cleanup = ["modern-cleanup", "legacy-cleanup", "legacy-late-cleanup"];
      const settled = await waitFor(events, (current) => cleanup.every((event) => current.includes(event)), "迟到入口未完成清理。");
      expect(settled).toContain("modern-finished:true");
      expect(settled).toContain("legacy-finished");

      const ticks = settled.filter((event) => event === "healthy-task").length;
      await waitFor(events, (current) => current.filter((event) => event === "healthy-task").length > ticks, "健康模块的任务未运行。");
      await checkHealthyModule();
      expect(await events()).not.toContain("healthy-signal-abort");

      host.kill("SIGTERM");
      expect(await host.exited).toBe(143);
      const recorded = await events();
      for (const event of [...cleanup, "healthy-signal-abort"]) expect(recorded.filter((item) => item === event)).toHaveLength(1);
      for (const event of ["modern-command", "legacy-command", "legacy-task"]) expect(recorded).not.toContain(event);
      expect(await stderr).toMatch(/a-slow-modern[^\n]*超时/u);
      expect(await stderr).toMatch(/b-slow-legacy[^\n]*超时/u);
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await host.exited;
      host.stdin.end();
      reader.releaseLock();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
