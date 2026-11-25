import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runLegacyMigration, processIdentity, updateMigrationState } from '../scripts/legacy-migrate.mjs';

async function fixture(run) {
  const parent = await mkdtemp(join(tmpdir(), 'lotus-legacy-worker-'));
  try {
    const source = join(parent, 'old'), target = join(parent, 'new'), work = join(parent, 'work');
    for (const path of [source, target, work]) await mkdir(path, { mode: 0o700 });
    const statePath = join(work, 'state.json');
    const old = { pid: 12345, execPath: '/fake/node', argv: ['old.js'], cwd: source, startTimeTicks: '77' };
    await writeFile(statePath, JSON.stringify({ oldHost: old, requestedBy: 'fixture' }), { mode: 0o600 });
    let running = true;
    const calls = [];
    const dependencies = {
      identity: async pid => running ? { ...old, pid } : null,
      kill: () => { running = false; },
      prepareBun: async () => '/fake/bun',
      execute: async (command, args) => { calls.push([command, ...args]); },
      sleep: async () => {
        const state = JSON.parse(await readFile(statePath, 'utf8'));
        if (state.phase === 'ready-to-stop') await updateMigrationState(statePath, { handoffApproved: true, receipt: 'last reply' });
      },
      restore: async () => { running = true; return 12346; },
    };
    await run({ source, target, statePath, old, dependencies, calls, running: () => running });
  } finally { await rm(parent, { recursive: true, force: true }); }
}

test('交接前不停止旧端，完成迁移、初始化和后台启动后才标记完成', () => fixture(async x => {
  const result = await runLegacyMigration(x, x.dependencies);
  assert.equal(result.phase, 'completed');
  assert.equal(result.receipt, 'last reply');
  assert.equal(x.running(), false);
  assert.deepEqual(x.calls.slice(-3).map(call => call.slice(1)), [['run', 'migrate', x.source], ['run', 'bootstrap'], ['run', 'start:bg']]);
}));
for (const failure of ['migrate', 'bootstrap', 'start:bg']) {
  test(`${failure}失败时停止已尝试的新端并恢复旧端`, () => fixture(async x => {
    const original = x.dependencies.execute;
    x.dependencies.execute = async (command, args) => { await original(command, args); if (args[1] === failure) throw Error('fixture failure'); };
    await assert.rejects(runLegacyMigration(x, x.dependencies));
    const result = JSON.parse(await readFile(x.statePath, 'utf8'));
    assert.equal(result.phase, 'failed'); assert.equal(result.recovery, 'old-restored'); assert.equal(x.running(), true);
    assert.equal(x.calls.some(call => call[2] === 'stop'), failure === 'start:bg');
  }));
}
test('新端停止不能确认时不恢复旧端，避免双端运行', () => fixture(async x => {
  x.dependencies.execute = async (_, args) => { if (['start:bg', 'stop'].includes(args[1])) throw Error('fixture unknown'); };
  await assert.rejects(runLegacyMigration(x, x.dependencies));
  assert.equal(JSON.parse(await readFile(x.statePath, 'utf8')).recovery, 'failed'); assert.equal(x.running(), false);
}));
test('身份不符或目标已有数据时不会结束旧端', () => fixture(async x => {
  await mkdir(join(x.target, 'data'));
  await assert.rejects(runLegacyMigration(x, x.dependencies)); assert.equal(x.running(), true); assert.equal(x.calls.length, 0);
}));
test('PM2按原id停止和恢复，恢复后验证online', () => fixture(async x => {
  await updateMigrationState(x.statePath, { oldHost: { ...x.old, pm2: { id: 9, cli: '/fake/pm2' } } });
  x.dependencies.execute = async (command, args) => {
    x.calls.push([command, ...args]);
    if (args[0] === 'stop') x.dependencies.identity = async () => null;
    if (args[1] === 'bootstrap') throw Error('fixture failure');
  };
  // The injected identity is closed over by the worker; PM2 exit is modelled explicitly.
  let running = true;
  x.dependencies.identity = async pid => running ? { ...x.old, pid } : null;
  x.dependencies.execute = async (command, args) => {
    x.calls.push([command, ...args]); if (args[0] === 'stop') running = false;
    if (args[0] === 'restart') running = true;
    if (args[1] === 'bootstrap') throw Error('fixture failure');
  };
  x.dependencies.capture = async () => JSON.stringify([{ pm_id: 9, pid: x.old.pid, pm2_env: { status: 'online' } }]);
  await assert.rejects(runLegacyMigration(x, x.dependencies));
  assert.equal(JSON.parse(await readFile(x.statePath, 'utf8')).recovery, 'old-restored');
  assert.ok(x.calls.some(call => call[0] === '/fake/pm2' && call[1] === 'stop' && call[2] === '9'));
}));
test('真实隔离Node进程身份记录包含启动时刻，退出后不再匹配', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    const identity = await processIdentity(child.pid);
    assert.equal(identity.execPath, await realpath(process.execPath));
    assert.ok(identity.startTimeTicks); assert.equal(identity.zombie, false);
  } finally { child.kill('SIGTERM'); await once(child, 'exit'); }
  assert.equal(await processIdentity(child.pid), null);
});
test('启动时刻变化后拒绝终止复用PID的新进程', () => fixture(async x => {
  x.dependencies.identity = async () => ({ ...x.old, startTimeTicks: '88' });
  await assert.rejects(runLegacyMigration(x, x.dependencies));
  assert.equal(x.running(), true); assert.equal(x.calls.length, 0);
}));
test('依赖安装有限重试，失败时旧机器人保持运行', () => fixture(async x => {
  let attempts = 0;
  x.dependencies.execute = async (_, args) => { if (args[0] === 'install') { attempts++; throw Error('network'); } };
  await assert.rejects(runLegacyMigration(x, x.dependencies));
  assert.equal(attempts, 3); assert.equal(x.running(), true);
  assert.equal(JSON.parse(await readFile(x.statePath, 'utf8')).recovery, 'old-untouched');
}));
test('交接后的取消也恢复旧端，取消信号不会阻止恢复', () => fixture(async x => {
  const controller = new AbortController();
  x.dependencies.execute = async (_, args) => { if (args[1] === 'migrate') controller.abort(); };
  await assert.rejects(runLegacyMigration({ ...x, signal: controller.signal }, x.dependencies));
  assert.equal(JSON.parse(await readFile(x.statePath, 'utf8')).recovery, 'old-restored');
  assert.equal(x.running(), true);
}));
test('新端清除旧LOTUS覆盖，旧PM2恢复保留原环境', () => fixture(async x => {
  const previous = process.env.LOTUS_PROFILE_DIR;
  process.env.LOTUS_PROFILE_DIR = '/fixture/old-private-data';
  try {
    await updateMigrationState(x.statePath, { oldHost: { ...x.old, pm2: { id: 7, cli: '/fake/pm2' } } });
    let running = true;
    x.dependencies.identity = async pid => running ? { ...x.old, pid } : null;
    x.dependencies.execute = async (command, args, options) => {
      if (command === '/fake/pm2') {
        assert.equal(options.env.LOTUS_PROFILE_DIR, '/fixture/old-private-data');
        if (args[0] === 'stop') running = false;
        if (args[0] === 'restart') running = true;
      } else assert.equal(options.env.LOTUS_PROFILE_DIR, undefined);
      if (args[1] === 'bootstrap') throw Error('fixture failure');
    };
    x.dependencies.capture = async () => JSON.stringify([{ pm_id: 7, pid: x.old.pid, pm2_env: { status: 'online' } }]);
    await assert.rejects(runLegacyMigration(x, x.dependencies));
    assert.equal(JSON.parse(await readFile(x.statePath, 'utf8')).recovery, 'old-restored');
  } finally {
    if (previous === undefined) delete process.env.LOTUS_PROFILE_DIR; else process.env.LOTUS_PROFILE_DIR = previous;
  }
}));
