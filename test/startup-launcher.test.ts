import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backgroundCleanStop, backgroundStartupFailure } from "../lib/managed-exit.ts";

const roots = new Set<string>();
const source = fileURLToPath(new URL("../", import.meta.url));
const index = JSON.stringify({ games: { gi: { locales: { zh: { pages: { weapon: {
  version: "7.2", recordCount: 1, records: { "1": { id: "1", name: "无锋剑", path: "items/1.json" } },
} } } } } } });

test.skipIf(process.platform === "win32")("中止实时日志时将信号转交当前 PM2 客户端并等待退出", async () => {
  const { cwd, launch } = await fixture();
  const parent = dirname(cwd);
  const home = join(parent, ".checkout.lotus-pm2");
  const bin = join(parent, "bin");
  const env = { PATH: bin + ":" + process.env.PATH };
  await Promise.all([mkdir(bin), mkdir(home, { mode: 0o700 })]);
  await writeFile(join(bin, "pm2"), `#!${process.execPath}
    import { writeFileSync } from "node:fs";
    const [command] = Bun.argv.slice(2);
    if (command === "jlist") {
      console.log(JSON.stringify([{ name: "lotus-yunzai", pm_id: 0, pid: 123, pm2_env: { status: "online" } }]));
    } else if (command === "logs") {
      const home = Bun.env.PM2_HOME;
      for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => {
          writeFileSync(home + "/forwarded", signal);
          process.exit(12);
        });
      }
      writeFileSync(home + "/log-client", String(process.pid));
      await new Promise(() => setInterval(() => {}, 100));
    } else process.exit(9);
  `, { mode: 0o700 });
  const daemon = Bun.listen({ unix: join(home, "rpc.sock"), socket: { data() {} } });
  const clientFile = join(home, "log-client");
  const forwarded = join(home, "forwarded");
  try {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      await Promise.all([rm(clientFile, { force: true }), rm(forwarded, { force: true })]);
      const launcher = launch(["logs"], env);
      const output = Promise.all([launcher.exited, new Response(launcher.stdout).text(), new Response(launcher.stderr).text()]);
      try {
        for (let attempt = 0; attempt < 80 && !await Bun.file(clientFile).exists(); attempt++) await Bun.sleep(20);
        expect(await Bun.file(clientFile).exists()).toBe(true);
        launcher.kill(signal);
        for (let attempt = 0; attempt < 80 && !await Bun.file(forwarded).exists(); attempt++) await Bun.sleep(20);
        expect(await readFile(forwarded, "utf8")).toBe(signal);
        expect((await output)[0]).toBe(12);
      } finally {
        if (!await Bun.file(forwarded).exists()) {
          const pid = Number(await readFile(clientFile, "utf8").catch(() => "0"));
          if (pid > 0) {
            try { process.kill(pid, "SIGKILL"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          }
        }
        if (launcher.exitCode === null) launcher.kill("SIGKILL");
        await output;
      }
    }
  } finally {
    daemon.stop(true);
  }
});

test.skipIf(process.platform === "win32")("PM2 登记丢失后仍可读后台历史日志", async () => {
  const { cwd, launch } = await fixture();
  const parent = dirname(cwd);
  const bin = join(parent, "log-fixture-bin");
  const home = join(parent, ".checkout.lotus-pm2");
  const logs = join(home, "logs");
  await mkdir(bin);
  await mkdir(home, { mode: 0o700 });
  await mkdir(logs);
  await writeFile(join(logs, "lotus-yunzai-out.log"), "out first\nprevious startup\n");
  await writeFile(join(logs, "lotus-yunzai-error.log"), "err first\nprevious error\n");
  await writeFile(join(bin, "pm2"), "#!/bin/sh\nexit 89\n", { mode: 0o700 });
  const env = { PATH: bin + ":" + process.env.PATH };

  for (const [options, expected] of [
    [["--out", "--lines=1"], "previous startup\n"],
    [["--err", "--lines", "1"], "previous error\n"],
  ] as const) {
    const child = launch(["logs", "--nostream", ...options], env);
    const [code, stdout, stderr] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(stdout).toBe(expected);
    expect(stderr).toBe("");
  }

  await rm(join(bin, "pm2"));
  const tail = Bun.which("tail");
  expect(tail).toBeString();
  await symlink(tail!, join(bin, "tail"));
  async function readWithoutPm2() {
    const child = launch(["logs", "--nostream", "--out", "--lines=1"], { PATH: bin });
    return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  }

  expect(await readWithoutPm2()).toEqual([0, "previous startup\n", ""]);
  const daemon = Bun.listen({ unix: join(home, "rpc.sock"), socket: { data() {} } });
  try {
    const [code, stdout, stderr] = await readWithoutPm2();
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("无法核实后台登记");
  } finally {
    daemon.stop(true);
  }
});

test.skipIf(process.platform === "win32")("后台启动准备按 dotenv 读图鉴，PM2 只收到命令的显式环境", async () => {
  const { cwd } = await fixture();
  const parent = dirname(cwd);
  const bin = join(parent, "bin");
  const atlas = join(cwd, "fixture-atlas");
  const home = join(parent, ".checkout.lotus-pm2");
  await Promise.all([mkdir(bin), mkdir(atlas), mkdir(home, { mode: 0o700 })]);
  await writeFile(join(atlas, "map.json"), index);
  await writeFile(join(cwd, ".env"), "LOTUS_ATLAS_DATA_DIR=fixture-atlas\nFIXTURE_VALUE=file\nFIXTURE_AUXILIARY=file\n");
  await writeFile(join(bin, "pm2"), `#!${process.execPath}
    const action = Bun.argv[2];
    const home = process.env.PM2_HOME;
    if (action === "jlist") console.log(await Bun.file(home + "/apps.json").text().catch(() => "[]"));
    else if (action === "start") {
      const { apps: [app] } = await Bun.file(Bun.argv[3]).json();
      await Bun.write(home + "/env.json", JSON.stringify([Bun.env.FIXTURE_VALUE, Bun.env.FIXTURE_AUXILIARY]));
      await Bun.write(home + "/apps.json", JSON.stringify([{ name: app.name, pid: 42, pm_id: 0,
        pm2_env: { status: "online", env: app.env } }]));
      await Bun.write(home + "/host-ready", "42");
    }
  `, { mode: 0o700 });
  const listener = Bun.listen({ unix: join(home, "rpc.sock"), socket: { data() {} } });
  try {
    const child = Bun.spawn([process.execPath, "run", "start:bg"], {
      cwd, env: { PATH: bin + ":" + process.env.PATH, FIXTURE_VALUE: "explicit" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 4_000,
    });
    const [code, warning] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(warning).not.toContain("还未选择图鉴版本来源");
    expect(await Bun.file(join(home, "env.json")).json()).toEqual(["explicit", null]);
  } finally {
    listener.stop(true);
  }
});

test.skipIf(process.platform === "win32")("PM2 运维优先选择实际登记的活跃实例，并等待登记的工作进程恢复就绪", async () => {
  const { cwd, launch, start } = await fixture();
  const parent = dirname(cwd);
  const bin = join(parent, "bin");
  const legacy = join(cwd, "data", ".pm2");
  const current = join(parent, ".checkout.lotus-pm2");
  const env = { PATH: bin + ":" + process.env.PATH };
  const atlas = join(cwd, "data/atlas/data");
  await Promise.all([mkdir(bin), mkdir(legacy, { recursive: true, mode: 0o700 }),
    mkdir(current, { mode: 0o700 }), mkdir(atlas, { recursive: true })]);
  await writeFile(join(atlas, "map.json"), index);
  await writeFile(join(bin, "pm2"), `#!${process.execPath}
    const action = Bun.argv[2];
    const home = process.env.PM2_HOME;
    if (action === "jlist") {
      console.log(await Bun.file(home + "/apps.json").text());
      if (process.env.FIXTURE_OBSERVE_READY && !await Bun.file(home + "/host-ready").exists()) {
        const calls = Bun.file(home + "/ready-queries");
        await Bun.write(calls.name, String(Number(await calls.text().catch(() => "0")) + 1));
      }
    }
    else if (action === "start") {
      const configured = process.env.FIXTURE_START_RESULT;
      if (!configured) process.exit(9);
      const [status, pid, ready] = JSON.parse(configured);
      const { apps: [app] } = await Bun.file(Bun.argv[3]).json();
      await Bun.write(home + "/apps.json", JSON.stringify([{ name: "lotus-yunzai", pid, pm_id: 0,
        pm2_env: { status, env: app.env } }]));
      if (ready) await Bun.write(home + "/host-ready", ready);
    }
    else if (action === "delete") {
      await Bun.write(home + "/delete-attempt", Bun.argv[3]);
      const records = await Bun.file(home + "/apps.json").json();
      const previous = records.find(item => String(item.pm_id) === Bun.argv[3]);
      if (previous?.pm2_env.status !== "stopped" || previous.pid !== 0) process.exit(8);
      await Bun.write(home + "/apps.json", "[]");
    }
    else console.log(home);
  `, { mode: 0o700 });
  await writeFile(join(current, "host-ready"), "999");
  await writeFile(join(legacy, "pm2.pid"), "999");
  const [emptyStatus, emptyOutput] = await start(["status"], env);
  expect(emptyStatus).toBe(0);
  expect(emptyOutput).toContain("当前目录未启动后台托管");

  const listeners = [current, legacy].map((path) => Bun.listen({
    unix: join(path, "rpc.sock"), socket: { data() {} },
  }));
  const setApp = (path: string, pid: number, status: string, token?: string, owned = true) => writeFile(join(path, "apps.json"),
    JSON.stringify([{ name: "lotus-yunzai", pm_id: 0, pid, pm2_env: { status, exec_interpreter: "none",
      pm_cwd: !owned ? bin : path === legacy ? cwd : parent,
      args: path === legacy ? [join(cwd, "scripts/run-managed.ts"), cwd, join(path, "host-ready")]
        : ["--no-env-file", join(path, "host-entry.js"), cwd, join(path, "host-ready"), ...token ? [token] : []],
      env: token && { LOTUS_PM2_START_TOKEN: token, LOTUS_PM2_WORKER_READINESS: "1" } } }]));
  try {
    await writeFile(join(current, "apps.json"), "[]");
    await setApp(legacy, 101, "online");
    await writeFile(join(legacy, "host-ready"), "101");
    for (const action of ["status", "logs", "stop"]) {
      const [code, output, error] = await start([action], env);
      expect({ code, error }).toEqual({ code: 0, error: "" });
      expect(output.trim()).toBe(legacy);
    }
    await setApp(legacy, 101, "online", undefined, false);
    const [unknownStop, unknownOutput, unknownError] = await start(["stop"], env);
    expect(unknownStop).toBe(1);
    expect(unknownOutput).toBe("");
    expect(unknownError).toContain("无法核实当前目录的 PM2 登记");
    await setApp(legacy, 101, "online");
    const [oldStart, oldOutput] = await start(["start:bg"], env);
    expect(oldStart).toBe(0);
    expect(oldOutput).toContain("后台宿主已运行");

    await setApp(legacy, 0, "stopped");
    expect((await start(["logs", "--nostream"], env))[1].trim()).toBe(legacy);

    await setApp(legacy, 101, "online");
    await setApp(current, 202, "online");
    await writeFile(join(current, "host-ready"), "202");
    expect((await start(["status"], env))[1].trim()).toBe(current);
    await writeFile(join(atlas, "map.json"), "fixture index temporarily unavailable\n");
    const [currentStart, currentOutput] = await start(["start:bg"], env);
    expect(currentStart).toBe(0);
    expect(currentOutput).toContain("后台宿主已运行");
    expect(await readFile(join(atlas, "map.json"), "utf8")).toBe("fixture index temporarily unavailable\n");

    await rm(join(current, "host-ready"));
    for (const outcome of ["same", "replaced", "interrupted"]) {
      await setApp(current, 202, "online", "original");
      const queries = join(current, "ready-queries");
      await writeFile(queries, "0");
      const observer = launch(["start:bg"], { ...env, FIXTURE_OBSERVE_READY: "1" });
      const output = Promise.all([observer.exited, new Response(observer.stdout).text(), new Response(observer.stderr).text()]);
      try {
        // The second query happens after the observer releases the startup lock.
        for (let count = 0; count < 100 && Number(await readFile(queries, "utf8")) < 2; count++) await Bun.sleep(20);
        expect(Number(await readFile(queries, "utf8"))).toBeGreaterThanOrEqual(2);
        expect(observer.exitCode).toBeNull();
        expect((await start(["stop"], env))[0]).toBe(0);
        expect(observer.exitCode).toBeNull();
        if (outcome === "interrupted") {
          observer.kill("SIGTERM");
        } else {
          if (outcome === "replaced") await setApp(current, 203, "online", "replacement");
          await writeFile(join(current, "host-ready"), outcome === "same" ? "202" : "203");
        }
        const [code, stdout, stderr] = await output;
        expect(code).toBe(outcome === "same" ? 0 : 1);
        if (outcome === "same") expect(stdout).toContain("后台宿主已运行");
        else expect(stdout).not.toContain("后台宿主已运行");
        if (outcome === "replaced") expect(stderr).toContain("等待期间后台宿主已停止或被替换");
        if (outcome === "interrupted") expect(stderr).toContain("启动操作已中止");
      } finally {
        if (observer.exitCode === null) observer.kill("SIGTERM");
        await output;
        await rm(join(current, "host-ready"), { force: true });
      }
    }
    await writeFile(join(atlas, "map.json"), index);

    await setApp(current, 0, "waiting restart");
    expect((await start(["start:bg"], env))[0]).toBe(1);

    await setApp(legacy, 0, "stopped");
    await setApp(current, 303, "stopped");
    const [stillHasPid, , stillHasPidError] = await start(["start:bg"], env);
    expect(stillHasPid).toBe(1);
    expect(stillHasPidError).toContain("无法替换已停止的 PM2 登记");
    expect(await Bun.file(join(current, "delete-attempt")).exists()).toBe(false);

    async function attempt(status: string, pid: number, ready: string) {
      await setApp(current, 0, "stopped");
      return start(["start:bg"], { ...env, FIXTURE_START_RESULT: JSON.stringify([status, pid, ready]) });
    }
    const [exitedCode, exitedOutput, exitedError] = await attempt("stopped", 0, "303");
    expect(exitedCode).toBe(1);
    expect(exitedOutput).not.toContain(current);
    expect(exitedError).toContain("后台宿主未就绪");
    const [recoveryCode, recoveryOutput] = await attempt("launching", 404, "303");
    expect(recoveryCode).toBe(1);
    expect(recoveryOutput).not.toContain(current);
    const [timeoutCode, timeoutOutput] = await attempt("online", 505, "");
    expect(timeoutCode).toBe(1);
    expect(timeoutOutput).toContain(current);
    expect((await attempt("online", 606, "606"))[0]).toBe(0);
  } finally {
    for (const listener of listeners) listener.stop(true);
  }
}, 15_000);

test.skipIf(process.platform === "win32")("取消后台启动只停止本次注册，信号可以先于 PM2 注册", async () => {
  for (const early of [false, true]) {
    const { cwd, launch } = await fixture();
    const parent = dirname(cwd);
    const bin = join(parent, "bin");
    const home = join(parent, ".checkout.lotus-pm2");
    const atlas = join(cwd, "data/atlas/data");
    const called = join(home, "called");
    const registered = join(home, "registered");
    const register = join(home, "allow-registration");
    await Promise.all([mkdir(bin), mkdir(home, { mode: 0o700 }), mkdir(atlas, { recursive: true })]);
    await writeFile(join(atlas, "map.json"), index);
    const other = { name: "unrelated", pm_id: 7, pid: 0, pm2_env: { status: "stopped", env: {} } };
    const old = { ...other, name: "lotus-yunzai", pm_id: 6 };
    await Bun.write(join(home, "apps.json"), JSON.stringify([other, old]));
    await writeFile(join(bin, "pm2"), `#!${process.execPath}
      const [action, operand] = Bun.argv.slice(2);
      const home = process.env.PM2_HOME;
      const apps = home + "/apps.json";
      if (action === "jlist") console.log(await Bun.file(apps).text());
      else if (action === "delete") {
        const records = await Bun.file(apps).json();
        const old = records.find(item => String(item.pm_id) === operand);
        if (old?.name !== "lotus-yunzai" || old.pm2_env.status !== "stopped") process.exit(8);
        await Bun.write(apps, JSON.stringify(records.filter(item => item !== old)));
      }
      else if (action === "start") {
        const { apps: [app] } = await Bun.file(operand).json();
        await Bun.write(home + "/called", "");
        while (!await Bun.file(home + "/allow-registration").exists()) await Bun.sleep(20);
        const appsBefore = await Bun.file(apps).json();
        await Bun.write(apps, JSON.stringify([...appsBefore, {
          name: app.name, pm_id: 8, pid: 505, pm2_env: { status: "launching", env: app.env },
        }]));
        await Bun.write(home + "/registered", "");
        while (!await Bun.file(home + "/stopped").exists()) await Bun.sleep(20);
      } else if (action === "stop") {
        const records = await Bun.file(apps).json();
        const selected = records.find(item => String(item.pm_id) === operand);
        if (!selected) process.exit(8);
        selected.pm2_env.status = "stopped";
        selected.pid = 0;
        await Bun.write(apps, JSON.stringify(records));
        await Bun.write(home + "/stopped", operand);
      }
    `, { mode: 0o700 });
    const daemon = Bun.listen({ unix: join(home, "rpc.sock"), socket: { data() {} } });
    const child = launch(["start:bg"], { PATH: bin + ":" + process.env.PATH });
    const output = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    async function wait(path: string) {
      for (let attempt = 0; attempt < 100 && !await Bun.file(path).exists(); attempt++) await Bun.sleep(20);
      expect(await Bun.file(path).exists()).toBe(true);
    }
    try {
      await wait(called);
      if (!early) {
        await Bun.write(register, "");
        await wait(registered);
      }
      child.kill("SIGTERM");
      if (early) {
        await Bun.sleep(100);
        await Bun.write(register, "");
      }
      const [code, , error] = await output;
      expect(code).toBe(1);
      expect(error).toContain("启动操作已中止");
      expect(await Bun.file(join(home, "stopped")).text()).toBe("8");
      expect(await Bun.file(join(home, "host-start-attempt")).exists()).toBe(false);
      expect(await Bun.file(join(home, "apps.json")).json()).toEqual([other, {
        name: "lotus-yunzai", pm_id: 8, pid: 0,
        pm2_env: { status: "stopped", env: {
          LOTUS_PM2_START_TOKEN: expect.any(String), LOTUS_PM2_WORKER_READINESS: "1",
        } },
      }]);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await output;
      daemon.stop(true);
    }
  }
}, 10_000);

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

test.skipIf(process.platform === "win32")("后台重启只触及本安装的已就绪 PM2 ID，拒绝同名、无登记和陈旧就绪标记", async () => {
  const { cwd, start } = await fixture();
  const parent = dirname(cwd);
  const home = join(parent, ".checkout.lotus-pm2");
  const bin = join(parent, "bin");
  const env = { PATH: bin + ":" + process.env.PATH };
  await mkdir(home, { mode: 0o700 });
  await mkdir(bin);
  const attempt = "27a10774-9dd7-4ad3-8f98-598cb1b09bca";
  const record = {
    name: "lotus-yunzai", pm_id: 3, pid: 303, pm2_env: {
      status: "online", pm_cwd: parent, exec_interpreter: "none",
      args: ["--no-env-file", join(home, "host-entry.js"), cwd, join(home, "host-ready"), attempt],
      env: { LOTUS_PM2_START_TOKEN: attempt, LOTUS_PM2_WORKER_READINESS: "1" },
    },
  };
  const writeApps = (items: unknown[]) => writeFile(join(home, "apps.json"), JSON.stringify(items));
  await writeFile(join(bin, "pm2"), `#!${process.execPath}
    const [action, id] = Bun.argv.slice(2);
    const home = Bun.env.PM2_HOME;
    const path = home + "/apps.json";
    if (action === "jlist") console.log(await Bun.file(path).text());
    else if (action === "restart" && id === "3") {
      await Bun.write(home + "/restarted-id", id);
      const apps = await Bun.file(path).json();
      apps[0].pid = 404;
      await Bun.write(path, JSON.stringify(apps));
      await Bun.write(home + "/host-ready", "404");
    } else process.exit(9);
  `, { mode: 0o700 });
  const daemon = Bun.listen({ unix: join(home, "rpc.sock"), socket: { data() {} } });
  try {
    await writeApps([]);
    const [emptyCode, , emptyError] = await start(["restart"], env);
    expect(emptyCode).toBe(1);
    expect(emptyError).toContain("未启动后台托管");
    await writeApps([{ ...record, pm2_env: { ...record.pm2_env, args: ["/another/service.js"] } }]);
    const [foreignCode, , foreignError] = await start(["restart"], env);
    expect(foreignCode).toBe(1);
    expect(foreignError).toContain("不属于当前安装目录");
    await writeApps([record]);
    await writeFile(join(home, "host-ready"), "299");
    const [staleCode, , staleError] = await start(["restart"], env);
    expect(staleCode).toBe(1);
    expect(staleError).toContain("工作进程尚未就绪");
    expect(await Bun.file(join(home, "restarted-id")).exists()).toBe(false);
    await writeFile(join(home, "host-ready"), "303");
    const [revokedCode, , revokedError] = await start(["restart"], env);
    expect(revokedCode).toBe(1);
    expect(revokedError).toContain("后台启动登记已失效");
    expect(await Bun.file(join(home, "restarted-id")).exists()).toBe(false);
    await writeFile(join(home, "host-start-attempt"), attempt);
    const [code, output, error] = await start(["restart"], env);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(output).toContain("后台宿主已重启");
    expect(await readFile(join(home, "restarted-id"), "utf8")).toBe("3");
    expect(await readFile(join(home, "host-ready"), "utf8")).toBe("404");
  } finally {
    daemon.stop(true);
  }
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lotus-startup-launcher-")));
  roots.add(root);
  const cwd = join(root, "checkout");
  await Promise.all(["lib", "plugins/atlas", "scripts", "config"].map((path) => mkdir(join(cwd, path), { recursive: true })));
  await Promise.all([
    ...["package.json", "scripts/launcher.ts", "scripts/startup.ts", "scripts/managed-entry.ts",
      "plugins/atlas/legacy-atlas-directory.ts", "plugins/atlas/snapshot-pointer.ts",
      "plugins/atlas/prepare-theme.ts", "plugins/atlas/theme-directories.ts"].map((path) =>
      copyFile(join(source, path), join(cwd, path))),
    ...["atlas-channel", "file-lock", "foreground-control", "managed-dispatch-pause", "managed-exit", "update-activation"].map((name) => writeFile(join(cwd, "lib", `${name}.ts`),
      `export * from ${JSON.stringify(join(source, "lib", `${name}.ts`))};\n`)),
    writeFile(join(cwd, "plugins/atlas/catalog.ts"),
      `export { createAtlasRuntimeCatalog } from ${JSON.stringify(join(source, "plugins/atlas/catalog.ts"))};\n`),
    writeFile(join(cwd, "scripts/run-managed.ts"),
      'export async function runManaged(_root, ready) { await ready?.(); console.log("fixture host ready"); return 0; }\n'),
    writeFile(join(cwd, "plugins/atlas/initialize-atlas.ts"), `
      import { appendFile, mkdir, symlink, writeFile } from "node:fs/promises";
      import { join } from "node:path";
      const [root, mode, cache, option, channel, ...extra] = Bun.argv.slice(2);
      if (!root || mode !== "--public" || !cache || option !== "--channel" ||
          channel !== "live" && channel !== "latest" || extra.length) process.exit(9);
      await mkdir(cache, { recursive: true });
      await appendFile(join(cache, "attempts"), channel + "\\n");
      if (Bun.env.FAIL_FIXTURE === "1") process.exit(8);
      if (Bun.env.WAIT_FIXTURE === "1") {
        while (!await Bun.file("allow-publication").exists()) await Bun.sleep(20);
      }
      await mkdir(join(root, "snapshots/52/data"), { recursive: true });
      await writeFile(join(root, "snapshots/52/data/map.json"), ${JSON.stringify(index)});
      await symlink("snapshots/52/data", join(root, "current"), "dir");
    `),
  ]);
  const config = join(cwd, "config/global.yaml");
  const attempts = join(cwd, "data/atlas-download/attempts");
  const launch = (args: string[], env: Record<string, string> = {}) =>
    Bun.spawn([process.execPath, "--no-env-file", "scripts/launcher.ts", ...args], {
      cwd, env: { PATH: process.env.PATH, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 4_000,
    });
  const start = (args: string[], env: Record<string, string> = {}) => {
    const child = launch(args, env);
    return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  };
  return { cwd, config, attempts, launch, start };
}

test("noninteractive first start requires a source choice before starting the host", async () => {
  const { config, attempts, start } = await fixture();
  const [code, output, error] = await start(["start"]);
  expect(code).toBe(1);
  expect(output).toBe("");
  expect(error).toContain("bun run init latest");
  expect(await Bun.file(config).exists()).toBe(false);
  expect(await Bun.file(attempts).exists()).toBe(false);
});

test("an already prepared installation starts without choosing a channel and rejects malformed YAML", async () => {
  const { cwd, config, attempts, start } = await fixture();
  const atlas = join(cwd, "data/atlas/data");
  await mkdir(atlas, { recursive: true });
  await writeFile(join(atlas, "map.json"), index);
  const [code, output, warning] = await start(["start"]);
  expect(code).toBe(0);
  expect(output).toContain("fixture host ready");
  expect(warning).toContain("缺少 12 个原主题文件");
  expect(await Bun.file(config).exists()).toBe(false);

  await writeFile(config, "atlas: [\n");
  const [invalid, , error] = await start(["start"]);
  expect(invalid).toBe(1);
  expect(error).toContain("无法读取 config/global.yaml");
  expect(await Bun.file(attempts).exists()).toBe(false);
});

test("an existing unusable index prevents startup without replacing legacy or explicit data", async () => {
  const { cwd, config, attempts, start } = await fixture();
  const atlas = join(cwd, "data/atlas/data");
  const override = join(cwd, "custom-atlas");
  await mkdir(atlas, { recursive: true });
  await mkdir(override);
  const invalid = "{}";
  await writeFile(join(atlas, "map.json"), invalid);
  await writeFile(join(override, "map.json"), "{");

  const [code, output, error] = await start(["start"]);
  expect(code).toBe(1);
  expect(output).not.toContain("fixture host ready");
  expect(error).toContain("图鉴索引不可用");
  const [customCode, customOutput, customError] = await start(["init", "live"], { LOTUS_ATLAS_DATA_DIR: override });
  expect(customCode).toBe(1);
  expect(customOutput).not.toContain("已就绪");
  expect(customError).toContain("LOTUS_ATLAS_DATA_DIR");
  expect(await Bun.file(config).exists()).toBe(false);
  expect(await Bun.file(attempts).exists()).toBe(false);
  expect(await readFile(join(atlas, "map.json"), "utf8")).toBe(invalid);
  expect(await readFile(join(override, "map.json"), "utf8")).toBe("{");

  await writeFile(join(override, "map.json"), index);
  const [repairedCode, repairedOutput] = await start(["start"], { LOTUS_ATLAS_DATA_DIR: "custom-atlas" });
  expect(repairedCode).toBe(0);
  expect(repairedOutput).toContain("fixture host ready");
  expect(await Bun.file(attempts).exists()).toBe(false);
});

test("first start retries incomplete preparation, preserves config, and reuses published data", async () => {
  const { config, attempts, start } = await fixture();
  await writeFile(config, "atlas:\n  update: true\n# unrelated settings\npermissions:\n  mode: partial\n");
  const [failed, , failure] = await start(["init", "live"], { FAIL_FIXTURE: "1" });
  expect(failed).toBe(1);
  expect(failure).toContain("下载记录已保留");
  const [started, output] = await start(["start"]);
  expect(started).toBe(0);
  expect(output).toContain("fixture host ready");
  expect((await start(["init", "latest"]))[0]).toBe(0);
  expect(await readFile(config, "utf8")).toContain("# unrelated settings");
  expect(Bun.YAML.parse(await readFile(config, "utf8"))).toEqual({
    atlas: { update: true, version_channel: "latest" },
    permissions: { mode: "partial" },
  });
  expect(await readFile(attempts, "utf8")).toBe("live\nlive\n");
});

test("simultaneous startup and initialization publish only once", async () => {
  const { cwd, attempts, start } = await fixture();
  const initialize = start(["init", "live"], { WAIT_FIXTURE: "1" });
  for (let attempt = 0; attempt < 50 && !await Bun.file(attempts).exists(); attempt++) await Bun.sleep(20);
  const firstStart = start(["start"]);
  await writeFile(join(cwd, "allow-publication"), "");
  const [[initStatus], [startStatus, output]] = await Promise.all([initialize, firstStart]);
  expect(initStatus).toBe(0);
  expect(startStatus).toBe(0);
  expect(output).toContain("fixture host ready");
  expect(await readFile(attempts, "utf8")).toBe("live\n");
});

test.skipIf(process.platform === "win32")("PM2 启动入口先恢复中断的目录切换，再加载原主管", async () => {
  const { cwd, config, start } = await fixture();
  const parent = dirname(cwd);
  const bin = join(parent, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "pm2"), `#!${process.execPath}
    const [, , action, config] = process.argv;
    if (action !== "start") process.exit(3);
    const { apps: [app] } = await Bun.file(config).json();
    const status = await Bun.spawn([app.script, ...app.args], {
      cwd: app.cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit",
    }).exited;
    process.exitCode = app.stop_exit_codes.includes(status) ? 0 : status;
  `, { mode: 0o700 });
  await mkdir(join(cwd, "data/atlas/data"), { recursive: true });
  await writeFile(join(cwd, "data/atlas/data/map.json"), index);
  await writeFile(config, "atlas: {version_channel: latest}\n");
  const [code, output, error] = await start(["start:bg"], { PATH: `${bin}:${process.env.PATH}` });
  // The fixture supervisor exits after ready and the PM2 stand-in registers no running process.
  expect(code).toBe(1);
  expect(output).toContain("fixture host ready");
  expect(error).toContain("后台宿主未就绪");
  const home = join(parent, ".checkout.lotus-pm2");
  const { apps: [app] } = await Bun.file(join(home, "host-process.json")).json();
  expect(app.cwd).toBe(parent);
  expect(app.stop_exit_codes).toContain(backgroundCleanStop);
  expect(app.stop_exit_codes).not.toContain(0);
  const readyFile = join(home, "host-ready");
  await rm(readyFile);

  const candidate = join(parent, "stage", "candidate");
  await mkdir(candidate, { recursive: true });
  await writeFile(join(candidate, "app.ts"), "candidate source");
  const id = crypto.randomUUID();
  const journal = join(parent, ".checkout.lotus-update.json");
  await writeFile(journal, JSON.stringify({ id, candidate, state: ["config", "data"], committed: false }));
  await rename(cwd, join(parent, `.checkout.lotus-previous-${id}`));

  const retry = Bun.spawn([app.script, ...app.args], {
    cwd: app.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 4_000,
  });
  const [status, stdout, stderr] = await Promise.all([retry.exited, new Response(retry.stdout).text(), new Response(retry.stderr).text()]);
  expect(stderr).toBe("");
  expect(status).toBe(backgroundCleanStop);
  expect(stdout).toContain("fixture host ready");
  expect(await readFile(readyFile, "utf8")).toBe(String(retry.pid));
  expect(await readFile(config, "utf8")).toBe("atlas: {version_channel: latest}\n");
  expect(await readFile(join(candidate, "app.ts"), "utf8")).toBe("candidate source");
  expect(await Bun.file(journal).exists()).toBe(false);
  await rm(join(home, "host-start-attempt"));
  const delayed = Bun.spawn([app.script, ...app.args], {
    cwd: app.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 4_000,
  });
  const [delayedStatus, delayedOutput, delayedError] = await Promise.all([
    delayed.exited, new Response(delayed.stdout).text(), new Response(delayed.stderr).text(),
  ]);
  expect(delayedStatus).toBe(backgroundStartupFailure);
  expect(delayedOutput).not.toContain("fixture host ready");
  expect(delayedError).toContain("本次后台启动已取消或被替换");
  expect(await readFile(readyFile, "utf8")).toBe(String(retry.pid));
});
