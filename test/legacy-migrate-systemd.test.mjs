import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isolateMigrationWorker, prepareSystemdTakeover } from '../scripts/legacy-migrate-systemd.mjs';

const run = promisify(execFile);
const userManagerAvailable = process.platform === 'linux' && Bun.spawnSync(['/usr/bin/systemctl', '--user', 'show-environment'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function localIdentity(pid) {
  try {
    const [cwd, stat, cmd, execPath] = await Promise.all([readlink(`/proc/${pid}/cwd`), readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/cmdline`, 'utf8'), readlink(`/proc/${pid}/exe`)]);
    return { pid, cwd, argv: cmd.split('\0').filter(Boolean).slice(1), startTimeTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], execPath };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'lotus-systemd-handoff-'));
  try {
    const source = join(root, 'old'), target = join(root, 'new'), work = join(root, 'work'), manager = join(root, 'manager');
    await Promise.all([source, target, work, manager].map(path => mkdir(path)));
    const unit = 'lotus-fixture.service', fragment = join(manager, unit), originalDrop = join(manager, unit + '.d', '30-original.conf');
    await mkdir(join(manager, unit + '.d'));
    await writeFile(fragment, '[Service]\nType=forking\nExecStart=/old/start\n');
    await writeFile(originalDrop, '[Service]\nEnvironment=PRIVATE_FIXTURE=original\n');
    const old = { pid: 100, cwd: source, argv: [join(source, 'app.js')], startTimeTicks: '123', env: {
      HOME: root, PATH: '/usr/bin:/bin', HTTP_PROXY: 'http://127.0.0.1:17891', SAFE_API: 'fixture',
      PM2_HOME: join(source, '.pm2'), NODE_OPTIONS: '--require old', LOTUS_DATA: join(source, 'data'), PWD: source, INVOCATION_ID: 'old-session', OLD_CUSTOM: join(source, 'cache'),
    } };
    const state = { MainPID: '100', ActiveState: 'active', SubState: 'running', LoadState: 'loaded', UnitFileState: 'enabled', FragmentPath: fragment,
      DropInPaths: originalDrop, WorkingDirectory: source, ExecStart: `/usr/bin/node ${old.argv[0]}`, ControlGroup: '/user.slice/lotus-fixture.service' };
    const calls = [], ready = join(target, 'data/boot-handoff/service-ready.json');
    let override, failedReady = false;
    const io = {
      userManagerEnvironment: async env => env,
      getuid: () => process.getuid(), processCredentials: async () => ({ uid: process.getuid(), gid: process.getgid() }), systemdDirectory: manager, sleep: () => pause(5),
      identity: async pid => Number(pid) === 100 ? { ...old } : Number(pid) === 200 ? { pid: 200, cwd: target, argv: ['scripts/launcher.ts'], startTimeTicks: '456' } : undefined,
      async capture(command, args) {
        calls.push([command, ...args]);
        if (command.endsWith('/sudo')) throw Error('permission denied');
        if (args.includes('show-environment')) return 'PM2_HOME=manager-old\nNODE_OPTIONS=manager-old\n';
        return Object.entries(state).map(([key, value]) => `${key}=${value}`).join('\n');
      },
      async execute(command, args) {
        calls.push([command, ...args]);
        if (command.endsWith('/install')) {
          if (args.includes('-d')) await mkdir(args.at(-1), { recursive: true, mode: parseInt(args[2], 8) });
          else { await copyFile(args.at(-2), args.at(-1)); await (await import('node:fs/promises')).chmod(args.at(-1), parseInt(args[1], 8)); }
          if (args.at(-1).endsWith('.conf')) override = args.at(-1);
        } else if (command.endsWith('/rm')) await rm(args.at(-1), { force: true });
        else if (args.includes('stop')) { state.MainPID = '0'; state.ActiveState = 'inactive'; }
        else if (args.includes('daemon-reload')) state.DropInPaths = originalDrop + (override && await Bun.file(override).exists() ? ' ' + override : '');
        else if (args.includes('start')) {
          const newer = override && await Bun.file(override).exists();
          state.MainPID = newer ? '200' : '100'; state.ActiveState = 'active';
          if (newer && !failedReady) await writeFile(ready, JSON.stringify({ pid: 200, root: target }), { mode: 0o600 });
        }
      },
    };
    await run({ root, source, target, work, manager, fragment, originalDrop, old, state, io, calls, ready,
      plan: { unit, scope: 'user', reason: 'old-bot-service', status: 'handoff-required' },
      options: { cwd: target, env: { HOME: root, PATH: '/usr/bin:/bin' }, systemdReadyTimeoutMs: 70 },
      failReady: () => { failedReady = true; } });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('systemd先备份和预检再停旧，清环境/旧命令，真实PID与ready核对后可回滚', () => fixture(async f => {
  const controller = await prepareSystemdTakeover(f.plan, f.old, f.target, process.execPath, f.work, f.options, f.io);
  expect(f.calls.some(row => row.includes('stop'))).toBe(false);
  expect(await Bun.file(join(f.target, 'data')).exists()).toBe(false);
  await controller.stopNew();
  expect(f.calls.some(row => row.includes('stop'))).toBe(false);
  const report = controller.report();
  expect((await lstat(report.backupDirectory)).mode & 0o077).toBe(0);
  expect((await lstat(join(report.backupDirectory, '0.unit'))).mode & 0o077).toBe(0);
  await controller.stopOld();
  expect(f.state.ActiveState).toBe('inactive');
  await controller.startNew();
  expect(controller.report()).toMatchObject({ status: 'active', newMainPID: 200, enabledState: 'enabled', newAutostartConfigured: true });
  expect(await Bun.file(report.mappingPath).json()).toEqual({ format: 1, root: f.target, unit: f.plan.unit, scope: 'user', uid: process.getuid() });
  expect((await lstat(report.mappingPath)).mode & 0o077).toBe(0);
  const drop = await readFile(report.dropInPath, 'utf8');
  for (const reset of ['Type=simple', 'PIDFile=', 'ExecStartPre=', 'ExecStartPost=', 'ExecStop=', 'ExecStopPost=', 'ExecReload=', 'EnvironmentFile=', 'PassEnvironment=', 'WorkingDirectory=']) expect(drop).toContain(reset);
  const envPath = drop.split('\n').find(line => line.startsWith('EnvironmentFile=/')).slice('EnvironmentFile='.length);
  const environment = await readFile(envPath, 'utf8');
  expect((await lstat(envPath)).mode & 0o077).toBe(0);
  expect(environment).toContain('HTTP_PROXY="http://127.0.0.1:17891"');
  expect(environment).toContain('SAFE_API="fixture"');
  for (const key of ['PM2_HOME=', 'NODE_OPTIONS=', 'LOTUS_DATA=', 'PWD=', 'INVOCATION_ID=', 'OLD_CUSTOM=']) expect(environment).not.toContain(key);
  expect(drop).toContain('UnsetEnvironment=');
  await controller.stopNew();
  expect(f.state.ActiveState).toBe('inactive');
  const stops = f.calls.filter(row => row.includes('stop')).length;
  await controller.stopNew();
  expect(f.calls.filter(row => row.includes('stop')).length).toBe(stops);
  await controller.rollback();
  expect(await Bun.file(report.mappingPath).exists()).toBe(false);
  expect(controller.report().status).toBe('rolled-back');
  expect(await Bun.file(report.dropInPath).exists()).toBe(false);
  expect(await readFile(f.fragment, 'utf8')).toBe('[Service]\nType=forking\nExecStart=/old/start\n');
  expect(await readFile(f.originalDrop, 'utf8')).toContain('PRIVATE_FIXTURE=original');
  expect(f.calls.some(row => row.includes('enable') || row.includes('disable'))).toBe(false);
}));

test('systemd拒绝越权、身份变化及停旧前配置变更', () => fixture(async f => {
  await expect(prepareSystemdTakeover({ ...f.plan, reason: 'persisted-old-pm2' }, f.old, f.target, process.execPath, f.work, f.options, f.io)).rejects.toMatchObject({ code: 'systemd_identity' });
  await expect(prepareSystemdTakeover({ ...f.plan, scope: 'system' }, f.old, f.target, process.execPath, f.work, f.options, f.io)).rejects.toMatchObject({ code: 'systemd_permissions' });
  expect(f.calls.some(row => row.includes('stop'))).toBe(false);
  const controller = await prepareSystemdTakeover(f.plan, f.old, f.target, process.execPath, f.work, f.options, f.io);
  await writeFile(f.originalDrop, 'changed');
  await expect(controller.stopOld()).rejects.toMatchObject({ code: 'systemd_conflict' });
  expect(f.calls.some(row => row.includes('stop'))).toBe(false);
}));

test('systemd不把active当就绪，ready缺失后回滚恢复旧单元', () => fixture(async f => {
  f.failReady();
  const controller = await prepareSystemdTakeover(f.plan, f.old, f.target, process.execPath, f.work, f.options, f.io);
  await controller.stopOld();
  await expect(controller.startNew()).rejects.toMatchObject({ code: 'systemd_ready' });
  await controller.rollback();
  expect(f.state.MainPID).toBe('100');
  expect(controller.report().status).toBe('rolled-back');
}));

// This uses only a newly-created unique user unit and temporary fake bots, never an existing unit.
test.skipIf(!userManagerAvailable)('真实user systemd专用单元接管、环境清理、ready和启动失败回滚', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lotus-real-user-systemd-'));
  const unit = `lotus-migration-fixture-${randomUUID()}.service`;
  const userDirectory = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config'), 'systemd/user');
  const fragment = join(userDirectory, unit);
  const source = join(root, 'old'), target = join(root, 'new'), work = join(root, 'work');
  const ctl = (...args) => run('/usr/bin/systemctl', ['--user', '--no-ask-password', '--no-pager', ...args], { env: process.env });
  let controller;
  try {
    await ctl('show-environment');
    await Promise.all([source, join(target, 'scripts'), work, userDirectory].map(path => mkdir(path, { recursive: true })));
    await writeFile(join(source, 'old.ts'), 'setInterval(() => {}, 1000);');
    await writeFile(join(target, 'scripts/launcher.ts'), `
      import { writeFile, readFile } from 'node:fs/promises';
      try {
      if (await Bun.file('fail').exists()) process.exit(7);
      if (process.env.PM2_HOME || process.env.LOTUS_OLD || process.env.NODE_OPTIONS) throw Error('old environment retained');
      if (process.env.HTTP_PROXY !== 'http://127.0.0.1:17891') throw Error('proxy lost:' + JSON.stringify({ present: !!process.env.HTTP_PROXY, length: process.env.HTTP_PROXY?.length, quoted: process.env.HTTP_PROXY?.startsWith('\"') }));
      await writeFile(process.env.LOTUS_SERVICE_READY_FILE, JSON.stringify({ pid: process.pid, root: process.cwd() }), { mode: 0o600 });
      setInterval(() => {}, 1000);
      } catch (error) { await writeFile('fixture-start-error', error.message); process.exit(1); }
    `);
    const oldEnvironment = join(root, 'old.env');
    await writeFile(oldEnvironment, `HTTP_PROXY=http://127.0.0.1:17891\nPM2_HOME=${source}/.pm2\nLOTUS_OLD=${source}/data\n`);
    await writeFile(fragment, `[Unit]\nDescription=Isolated migration test\n[Service]\nType=simple\nWorkingDirectory=${source}\nExecStart=${process.execPath} ${join(source, 'old.ts')}\nEnvironmentFile=${oldEnvironment}\nRestart=always\n[Install]\nWantedBy=default.target\n`);
    await ctl('daemon-reload'); await ctl('enable', unit); await ctl('start', unit);
    const current = async () => Number((await ctl('show', unit, '--property=MainPID', '--value')).stdout.trim());
    const oldReady = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const identity = await localIdentity(await current());
        if (identity?.cwd === source && identity.argv.includes(join(source, 'old.ts'))) return identity;
        await pause(20);
      }
      throw Error('fixture old bot did not execute');
    };
    const capture = async (command, args, options) => (await run(command, args, { env: { ...process.env, ...options.env }, signal: options.signal })).stdout;
    const io = { capture, execute: capture, identity: localIdentity, sleep: pause };
    const options = { env: { ...process.env }, systemdReadyTimeoutMs: 3000 };
    const plan = { unit, scope: 'user', reason: 'old-bot-service' };
    let old = await oldReady(); old.env = { ...process.env, HTTP_PROXY: 'http://127.0.0.1:17891', PM2_HOME: join(source, '.pm2'), LOTUS_OLD: join(source, 'data') };
    controller = await prepareSystemdTakeover(plan, old, target, process.execPath, work, options, io);
    await controller.stopOld();
    const active = await controller.startNew();
    expect(active.status).toBe('active'); expect((await localIdentity(await current())).cwd).toBe(target);
    expect((await ctl('is-enabled', unit)).stdout.trim()).toBe('enabled');
    await controller.rollback(); expect((await localIdentity(await current())).cwd).toBe(source);
    expect((await ctl('is-enabled', unit)).stdout.trim()).toBe('enabled');
    await writeFile(join(target, 'fail'), 'fixture');
    old = await oldReady(); old.env = { ...process.env, HTTP_PROXY: 'http://127.0.0.1:17891' };
    controller = await prepareSystemdTakeover(plan, old, target, process.execPath, work, options, io);
    await controller.stopOld();
    await expect(controller.startNew()).rejects.toThrow();
    await controller.rollback(); expect((await localIdentity(await current())).cwd).toBe(source);
    expect((await ctl('is-enabled', unit)).stdout.trim()).toBe('enabled');
  } catch (error) {
    const detail = await ctl('status', unit).then(value => value.stdout, cause => cause.stdout + cause.stderr);
    const validation = await run('/usr/bin/systemd-analyze', ['--user', 'verify', fragment]).then(value => value.stdout, cause => cause.stdout + cause.stderr);
    const observed = await readFile(join(target, 'fixture-start-error'), 'utf8').catch(() => 'no fixture error file');
    const envFiles = (await readdir(join(target, 'data/boot-handoff')).catch(() => [])).filter(name => name.startsWith('systemd-environment-'));
    const prepared = envFiles.length ? await readFile(join(target, 'data/boot-handoff', envFiles[0]), 'utf8') : '';
    throw new Error(detail + '\n' + validation + '\n' + observed, { cause: error });
  } finally {
    await ctl('stop', unit).catch(() => {}); await ctl('disable', unit).catch(() => {});
    await rm(fragment, { force: true }); await rm(join(userDirectory, unit + '.d'), { recursive: true, force: true });
    await ctl('daemon-reload').catch(() => {}); await ctl('reset-failed', unit).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);


test('systemd停旧前必须离开旧cgroup，detached PID本身不作为已逃逸证据', () => fixture(async f => {
  const io = { ...f.io, readWorkerCgroup: async () => `0::${f.state.ControlGroup}/migration-worker\n` };
  await expect(prepareSystemdTakeover(f.plan, f.old, f.target, process.execPath, f.work, f.options, io))
    .rejects.toMatchObject({ code: 'systemd_preflight', requiresDetachedWorker: true });
  expect(f.calls.some(row => row.includes('stop'))).toBe(false);
  const controller = await prepareSystemdTakeover(f.plan, f.old, f.target, process.execPath, f.work, f.options, f.io);
  f.io.readWorkerCgroup = io.readWorkerCgroup;
  await expect(controller.stopOld()).rejects.toMatchObject({ requiresDetachedWorker: true });
  expect(f.calls.some(row => row.includes('stop'))).toBe(false);
}));


test('已在旧unit外的worker不另建服务或写令牌文件', () => fixture(async f => {
  const result = await isolateMigrationWorker({ ...f.plan, controlGroup: f.state.ControlGroup }, f.old, f.target, f.work, f.options, f.io, 'x'.repeat(40));
  expect(result).toEqual({ isolated: false, reason: 'already-isolated' });
  expect(f.calls).toEqual([]); expect(await readdir(f.work)).toEqual([]);
}));

test.skipIf(!userManagerAvailable)('真实旧unit内worker通过独立transient service逃逸，停旧不杀新worker且后代独立保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lotus-real-worker-isolation-'));
  const unit = `lotus-isolation-fixture-${randomUUID()}.service`;
  const userDirectory = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config'), 'systemd/user');
  const fragment = join(userDirectory, unit), source = join(root, 'old'), target = join(root, 'new'), work = join(root, 'work');
  const reportPath = join(root, 'isolated.json'), readyPath = join(root, 'resumed.json');
  const ctl = (...args) => run('/usr/bin/systemctl', ['--user', '--no-ask-password', '--no-pager', ...args]);
  let report, childPid;
  try {
    await ctl('show-environment');
    await Promise.all([source, target, work, userDirectory].map(path => mkdir(path, { recursive: true })));
    const childFile = join(target, 'child.mjs'), workerFile = join(target, 'resume.mjs');
    await writeFile(childFile, 'setInterval(() => {}, 1000);');
    await writeFile(workerFile, `
      import { writeFile } from 'node:fs/promises';
      const child = Bun.spawn([process.execPath, ${JSON.stringify(childFile)}], { cwd: process.cwd(), detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      child.unref();
      await writeFile(${JSON.stringify(readyPath)}, JSON.stringify({ pid: process.pid, child: child.pid, tokenValid: process.env.LOTUS_MIGRATION_RESUME_TOKEN === ${JSON.stringify('x'.repeat(40))} }), { mode: 0o600 });
      process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);
    `);
    await writeFile(join(source, 'old.mjs'), `
      import { readFile, readlink, writeFile } from 'node:fs/promises';
      import { execFile } from 'node:child_process';
      import { promisify } from 'node:util';
      import { isolateMigrationWorker } from ${JSON.stringify(new URL('../scripts/legacy-migrate-systemd.mjs', import.meta.url).href)};
      ${localIdentity.toString()}
      const run = promisify(execFile);
      const capture = async (command, args, options) => (await run(command, args, { env: options.env, signal: options.signal })).stdout;
      const controlGroup = (await run('/usr/bin/systemctl', ['--user', 'show', ${JSON.stringify(unit)}, '--property=ControlGroup', '--value'])).stdout.trim();
      const old = await localIdentity(process.pid); old.env = { ...process.env };
      delete old.env.XDG_RUNTIME_DIR; delete old.env.DBUS_SESSION_BUS_ADDRESS;
      const result = await isolateMigrationWorker({ unit: ${JSON.stringify(unit)}, scope: 'system', reason: 'old-bot-service', controlGroup }, old, ${JSON.stringify(target)}, ${JSON.stringify(work)},
        { env: { ...old.env }, isolationCommand: [process.execPath, ${JSON.stringify(workerFile)}] },
        { execute: capture, capture, identity: localIdentity, sleep: ms => new Promise(done => setTimeout(done, ms)) }, ${JSON.stringify('x'.repeat(40))});
      await writeFile(${JSON.stringify(reportPath)}, JSON.stringify({ ...result, oldControlGroup: controlGroup }), { mode: 0o600 });
      setInterval(() => {}, 1000);
    `);
    await writeFile(fragment, `[Service]\nType=exec\nWorkingDirectory=${source}\nExecStart=${process.execPath} ${join(source, 'old.mjs')}\nEnvironment=XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR} HOME=${process.env.HOME}\n`);
    await ctl('daemon-reload'); await ctl('start', unit);
    const until = Date.now() + 8000;
    while (!await Bun.file(reportPath).exists() && Date.now() < until) await pause(50);
    report = await Bun.file(reportPath).json();
    while (!await Bun.file(readyPath).exists() && Date.now() < until) await pause(50);
    const ready = await Bun.file(readyPath).json(); childPid = ready.child;
    expect(report.isolated).toBe(true); expect(report.scope).toBe('user'); expect(ready.tokenValid).toBe(true); expect(ready.pid).toBe(report.pid);
    expect(report.controlGroup).not.toBe(report.oldControlGroup);
    expect(report.controlGroup.startsWith(report.oldControlGroup + '/')).toBe(false);
    await ctl('stop', unit);
    expect((await localIdentity(report.pid)).cwd).toBe(target);
    expect((await ctl('show', report.unit, '--property=ActiveState', '--value')).stdout.trim()).toBe('active');
    await ctl('stop', report.unit);
    expect(await localIdentity(report.pid)).toBe(null);
    expect((await localIdentity(childPid)).cwd).toBe(target);
  } finally {
    await ctl('stop', unit).catch(() => {});
    if (!report && await Bun.file(reportPath).exists()) report = await Bun.file(reportPath).json();
    if (!childPid && await Bun.file(readyPath).exists()) childPid = (await Bun.file(readyPath).json()).child;
    if (report?.unit) await ctl('stop', report.unit).catch(() => {});
    if (childPid && (await localIdentity(childPid))?.cwd === target) process.kill(childPid, 'SIGKILL');
    await rm(fragment, { force: true }); await ctl('daemon-reload').catch(() => {}); await ctl('reset-failed', unit).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);


test('系统服务安装的环境与映射归源UID所有，CAS不删除他人替换的映射', () => fixture(async f => {
  const io = { ...f.io, getuid: () => 0 };
  const controller = await prepareSystemdTakeover({ ...f.plan, scope: 'system' }, f.old, f.target, process.execPath, f.work, f.options, io);
  expect(await Bun.file(join(f.target, 'data')).exists()).toBe(false);
  await controller.stopOld(); await controller.startNew();
  const paths = controller.report();
  const mapping = await Bun.file(paths.mappingPath).json();
  expect(mapping.scope).toBe('system'); expect(mapping.uid).toBe(process.getuid());
  const installs = f.calls.filter(row => row[0].endsWith('/install') && row.includes('0600'));
  expect(installs.length).toBe(2);
  for (const row of installs) { expect(row).toContain('-o'); expect(row).toContain(String(process.getuid())); expect(row).toContain('-g'); expect(row).toContain(String(process.getgid())); }
  await rm(paths.mappingPath);
  await writeFile(paths.mappingPath, JSON.stringify({ ...mapping, unit: 'other-owner.service' }), { mode: 0o600 });
  await controller.stopNew(); await controller.rollback();
  expect((await Bun.file(paths.mappingPath).json()).unit).toBe('other-owner.service');
}));
