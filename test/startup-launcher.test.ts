import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, test } from "bun:test";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backgroundCleanStop, backgroundStartupFailure } from "../lib/managed-exit.ts";
import { readServerSettings } from "../lib/server.ts";

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
  expect(emptyOutput).toContain("Lotus-Yunzai 未在后台运行");

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
    expect(oldOutput).toContain("已在后台运行");

    await setApp(legacy, 0, "stopped");
    expect((await start(["logs", "--nostream"], env))[1].trim()).toBe(legacy);

    await setApp(legacy, 101, "online");
    await setApp(current, 202, "online");
    await writeFile(join(current, "host-ready"), "202");
    expect((await start(["status"], env))[1].trim()).toBe(current);
    await writeFile(join(atlas, "map.json"), "fixture index temporarily unavailable\n");
    const [currentStart, currentOutput] = await start(["start:bg"], env);
    expect(currentStart).toBe(0);
    expect(currentOutput).toContain("已在后台运行");
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
        if (outcome === "same") expect(stdout).toContain("已在后台运行");
        else expect(stdout).not.toContain("已在后台运行");
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
        name: "LOTUS-YUNZAI", pm_id: 8, pid: 0,
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
    expect(emptyError).toContain("未在后台运行");
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
    expect(output).toContain("重启成功");
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
      "plugins/atlas/legacy-atlas-directory.ts", "plugins/atlas/snapshot-pointer.ts", "plugins/atlas/locale.ts",
      "plugins/atlas/source-values.ts", "plugins/atlas/initialization-progress.ts",
      "plugins/atlas/theme-directories.ts"].map((path) =>
      copyFile(join(source, path), join(cwd, path))),
    ...["atlas-channel", "lotus-global-config", "file-lock", "foreground-control", "managed-dispatch-pause", "managed-exit", "migrated-onebot-setup",
      "migration-publication", "startup-render-preset", "update-activation", "initialization-progress", "terminal-log-format", "terminal-output", "runtime-logs", "shanghai-date", "initialize-resources", "initialize-terminal-owner"].map((name) => writeFile(join(cwd, "lib", `${name}.ts`),
      `export * from ${JSON.stringify(join(source, "lib", `${name}.ts`))};\n`)),
    writeFile(join(cwd, "plugins/atlas/catalog.ts"),
      `export { createAtlasRuntimeCatalog } from ${JSON.stringify(join(source, "plugins/atlas/catalog.ts"))};\n`),
    writeFile(join(cwd, "plugins/atlas/update-policy.ts"),
      `export { atlasUpdatePublicationOptions } from ${JSON.stringify(join(source, "plugins/atlas/update-policy.ts"))};\n`),
    writeFile(join(cwd, "plugins/atlas/prepare-theme.ts"), 'export async function prepareAtlasTheme() { return { copied: [], missing: Array(12).fill("fixture") }; }\n'),
    writeFile(join(cwd, "lib/daily-note-theme.ts"), 'export async function prepareDailyNoteTheme() { return "available"; }\n'),
    writeFile(join(cwd, "scripts/run-managed.ts"),
      'export async function runManaged(_root, ready) { await ready?.(); console.log("fixture host ready"); return 0; }\n'),
    writeFile(join(cwd, "plugins/atlas/initialize-atlas.ts"), `
      import { appendFile, mkdir, symlink, writeFile } from "node:fs/promises";
      import { join } from "node:path";
      export async function initializeAtlasFromPublic(root, cache, signal, channel, { locale, publication }) {
        if (!root || !cache || channel !== "live" && channel !== "latest" || locale !== "zh" || !publication) {
          throw new Error("unexpected public Atlas initialization options");
        }
        await mkdir(cache, { recursive: true });
        await appendFile(join(cache, "attempts"), channel + "\\n");
        if (Bun.env.FAIL_FIXTURE === "1") throw new Error("fixture download failure");
        if (Bun.env.WAIT_FIXTURE === "1") {
          while (!await Bun.file("allow-publication").exists()) {
            signal.throwIfAborted();
            await Bun.sleep(20);
          }
        }
        const directory = join(root, "snapshots/52/data");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "map.json"), ${JSON.stringify(index)});
        await symlink("snapshots/52/data", join(root, "current"), "dir");
        return { status: "published", version: 52, directory };
      }
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
  const { cwd, config, attempts, start } = await fixture();
  const [code, output, error] = await start(["start"]);
  expect(code).toBe(1);
  expect(output).toBe("");
  expect(error).toContain("bun run bootstrap");
  expect(await Bun.file(config).exists()).toBe(false);
  expect(await Bun.file(join(cwd, "config/bot.yaml")).exists()).toBe(false);
  expect(await Bun.file(attempts).exists()).toBe(false);
});

test("非交互完整初始化默认最新版并完成首次设置，随后启动不再要求初始化", async () => {
  const { cwd, config, attempts, start } = await fixture();
  const [code, output, error] = await start(["init"]);
  expect(code).toBe(0);
  expect(error).not.toContain("尚未完成初始化");
  expect(output).toContain("已就绪");
  expect((await Bun.file(config).text())).toContain("latest");
  expect((await Bun.file(join(cwd, "config/bot.yaml")).text())).toContain("standard");
  expect(await Bun.file(attempts).text()).toBe("latest\n");
  const [started, ready] = await start(["start"]);
  expect(started).toBe(0);
  expect(ready).toContain("fixture host ready");
  expect(await Bun.file(attempts).text()).toBe("latest\n");
});

test.skipIf(process.platform === "win32")("显式初始化用一个实际终端选择图鉴与低配档，普通启动只复用配置", async () => {
  const { cwd, config, start } = await fixture();
  const ready = Promise.withResolvers<void>();
  let output = "";
  let answeredAtlas = false;
  let answeredRender = false;
  const decoder = new TextDecoder();
  const launcher = Bun.spawn([process.execPath, "--no-env-file", "scripts/launcher.ts", "init"], {
    cwd, env: { PATH: process.env.PATH },
    terminal: { data(terminal, bytes) {
      output += decoder.decode(bytes, { stream: true });
      if (!answeredAtlas && output.includes("图鉴版本 [")) {
        answeredAtlas = true;
        terminal.write("2\n");
      }
      if (!answeredRender && output.includes("图片渲染档位 [")) {
        answeredRender = true;
        terminal.write("low\n");
      }
      if (stripVTControlCharacters(output).includes("[初始化] 已就绪")) ready.resolve();
    } },
  });
  const deadline = setTimeout(() => ready.reject(new Error("终端初始化未完成。\n" + output)), 4_000);
  try {
    await ready.promise;
    expect(await launcher.exited).toBe(0);
    expect(output).toContain("标准配置（4×");
    expect(output).toContain("低配配置（1×");
    expect(Bun.YAML.parse(await readFile(config, "utf8"))).toEqual({ atlas: { version_channel: "live" } });
    const bot = join(cwd, "config/bot.yaml");
    const initial = await readFile(bot, "utf8");
    expect(Bun.YAML.parse(initial)).toEqual({ imageRenderPreset: "low" });
    expect((await start(["start"]))[0]).toBe(0);
    expect((await start(["init"]))[0]).toBe(0);
    expect(await readFile(bot, "utf8")).toBe(initial);
  } finally {
    clearTimeout(deadline);
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
    await launcher.exited;
    launcher.terminal?.close();
  }
});

test("已有图鉴时普通暖启不写旧 bot.yaml，显式 init 写入缺失档位且保留原 YAML", async () => {
  const { cwd, start } = await fixture();
  const atlas = join(cwd, "data/atlas/data");
  const legacyDirectory = join(cwd, "config/config");
  const bot = join(legacyDirectory, "bot.yaml");
  const original = "# 原有说明\nfile_watch: false # 保留旧选项\n";
  await Promise.all([mkdir(atlas, { recursive: true }), mkdir(legacyDirectory)]);
  await Promise.all([writeFile(join(atlas, "map.json"), index), writeFile(bot, original)]);
  expect((await start(["start"]))[0]).toBe(0);
  expect(await readFile(bot, "utf8")).toBe(original);
  expect((await start(["init"]))[0]).toBe(0);
  const initialized = await readFile(bot, "utf8");
  expect(initialized).toBe(original + "imageRenderPreset: standard\n");
  expect(await Bun.file(join(cwd, "config/bot.yaml")).exists()).toBe(false);
  expect((await start(["init"]))[0]).toBe(0);
  expect(await readFile(bot, "utf8")).toBe(initialized);
});

test("an already prepared installation starts without choosing a channel and rejects malformed YAML", async () => {
  const { cwd, config, attempts, start } = await fixture();
  const atlas = join(cwd, "data/atlas/data");
  await mkdir(atlas, { recursive: true });
  await writeFile(join(atlas, "map.json"), index);
  const [code, output, warning] = await start(["start"]);
  expect(code).toBe(0);
  expect(output).toContain("fixture host ready");
  expect(warning).toContain("12 个图鉴卡片背景或字体尚未备齐");
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
  const { cwd, config, attempts, start } = await fixture();
  await writeFile(config, "atlas:\n  update: true\n# unrelated settings\npermissions:\n  mode: partial\n");
  const [failed, , failure] = await start(["init", "live"], { FAIL_FIXTURE: "1" });
  expect(failed).toBe(1);
  expect(failure).toContain("下载记录已保留");
  expect((await start(["start"]))[0]).toBe(1);
  expect(await readFile(attempts, "utf8")).toBe("live\n");
  expect((await start(["init", "live"]))[0]).toBe(0);
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
  expect(Bun.YAML.parse(await readFile(join(cwd, "config/bot.yaml"), "utf8"))).toEqual({ imageRenderPreset: "standard" });
});

test("first initialization can fetch the original Star Rail theme while a prepared start only reuses local assets", async () => {
  const { cwd, start } = await fixture();
  const directory = join(cwd, "plugins/starrail");
  const attempts = join(cwd, "starrail-theme-attempts");
  await mkdir(directory);
  await writeFile(join(directory, "challenge-theme.ts"), `
    import { appendFile } from "node:fs/promises";
    export async function prepareStarRailChallengeTheme(root, { download }) {
      await appendFile(new URL("starrail-theme-attempts", root), download ? "download\\n" : "local\\n");
      return { templates: 0, portraits: 0, missing: [] };
    }
  `);
  expect((await start(["init", "live"]))[0]).toBe(0);
  expect((await start(["start"]))[0]).toBe(0);
  expect(await readFile(attempts, "utf8")).toBe("download\nlocal\n");
});

test("原神祈愿日历首装可联网，离线后启动保持可用且暖启不请求", async () => {
  const { cwd, start } = await fixture();
  const directory = join(cwd, "plugins/genshin");
  const attempts = join(cwd, "wish-calendar-attempts");
  await mkdir(directory);
  await writeFile(join(directory, "wish-calendar.ts"), `
    import { appendFile } from "node:fs/promises";
    export async function prepareGenshinWishCalendar(root, { download }) {
      await appendFile(new URL("wish-calendar-attempts", root), download ? "download\\n" : "local\\n");
      return "missing";
    }
  `);
  const [init, , warning] = await start(["init", "live"]);
  expect(init).toBe(0);
  expect(warning).toContain("原祈愿日历暂不可用");
  const [warm, output, warmWarning] = await start(["start"]);
  expect(warm).toBe(0);
  expect(output).toContain("fixture host ready");
  expect(warmWarning).not.toContain("原祈愿日历暂不可用");
  expect(await readFile(attempts, "utf8")).toBe("download\nlocal\n");
});

test("a migrated LAN OneBot listener keeps its address and does not generate a token", async () => {
  const { cwd, start } = await fixture();
  await mkdir(join(cwd, "data/atlas/data"), { recursive: true });
  await writeFile(join(cwd, "data/atlas/data/map.json"), index);
  const file = join(cwd, "config/server.yaml");
  const legacy = "port: 9020 # retain the previous listener\nonebot_token: null\n";
  await writeFile(file, legacy, { mode: 0o600 });
  expect((await start(["start"]))[0]).toBe(0);
  expect((await start(["init"]))[0]).toBe(0);
  expect(await readFile(file, "utf8")).toBe(legacy);
  const network = await readServerSettings(Bun.pathToFileURL(`${cwd}/`), {});
  expect(network.oneBot?.port).toBe(9020);
  expect(network.oneBot?.auth.has("Authorization")).toBe(false);
  expect((await lstat(file)).mode & 0o777).toBe(0o600);
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

test("绝区零调频主题随首次初始化准备，普通暖启只尝试本地恢复", async () => {
  const { cwd, start } = await fixture();
  const module = join(cwd, "plugins/zzz");
  const calls = join(cwd, "zzz-theme-calls.jsonl");
  await mkdir(module);
  await Promise.all([
    writeFile(join(module, "tuning-detail-card.ts"), ""),
    writeFile(join(cwd, "lib/zzz-tuning-theme.ts"), `
      import { appendFile } from "node:fs/promises";
      export async function prepareZzzTuningTheme(root, { override, signal, download }) {
        if (!root || !(signal instanceof AbortSignal)) throw Error("主题启动参数缺失");
        await appendFile(${JSON.stringify(calls)}, JSON.stringify({ override, download }) + "\\n");
        return download ? "installed" : "available";
      }
    `),
  ]);

  const [initialCode, initialOutput] = await start(["init", "live"]);
  expect(initialCode).toBe(0);
  expect(initialOutput).toContain("已准备原调频与逐抽主题");
  expect((await start(["start"], { LOTUS_ZZZ_GACHA_THEME_DIR: "./custom-theme" }))[0]).toBe(0);
  const requests = (await Bun.file(calls).text()).trim().split("\n").map(line => JSON.parse(line));
  expect(requests).toEqual([{ download: true }, { override: "./custom-theme", download: false }]);
});

test("初始化准备图库攻略媒体，后续普通启动不再调用任何下载入口", async () => {
  const { cwd, start } = await fixture();
  await mkdir(join(cwd, "plugins/guides"), { recursive: true });
  await mkdir(join(cwd, "plugins/media/services/tools"), { recursive: true });
  const common = `import { appendFile } from "node:fs/promises";
    const record = async (root, name) => {
      if (Bun.env.FORBID_RESOURCE_DOWNLOAD === "1") throw Error("普通启动不得下载");
      await appendFile(new URL("prepared-resources", root), name + "\\n");
    };\n`;
  await writeFile(join(cwd, "plugins/guides/initialize-resources.ts"), common + `export async function prepareGuideResources(root) { await record(root,"guides"); }`);
  await writeFile(join(cwd, "plugins/media/services/tools/initialize.ts"), common + `export async function prepareMediaEnvironment(root) { await record(root,"media"); }`);
  await writeFile(join(cwd, "lib/character-gallery-sync.ts"), `
    export async function syncCharacterGallery(options) {
      if (Bun.env.FORBID_RESOURCE_DOWNLOAD === "1") throw Error("普通启动不得下载");
      await Bun.write(options.root + "/prepared", "gallery"); return {};
    }
  `);
  expect((await start(["init"]))[0]).toBe(0);
  expect(await Bun.file(join(cwd, "data/character-gallery-synced/prepared")).text()).toBe("gallery");
  expect(await Bun.file(join(cwd, "prepared-resources")).text()).toBe("guides\nmedia\n");
  const [code, ready] = await start(["start"], { FORBID_RESOURCE_DOWNLOAD: "1" });
  expect(code).toBe(0);
  expect(ready).toContain("fixture host ready");
  expect(await Bun.file(join(cwd, "prepared-resources")).text()).toBe("guides\nmedia\n");
});
