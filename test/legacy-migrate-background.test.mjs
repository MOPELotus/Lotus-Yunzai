import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMigrationPm2, inspectLegacyBoot } from '../scripts/legacy-migrate-background.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const old = { pid: 123, execPath: '/usr/bin/node', cwd: '/fixture/old', argv: ['app.js'], env: { HOME: '/fixture/home' } };
function environment({ cgroup, service = {}, pm2 = false, dump = [] }) {
  const snapshot = { ...old, ...(pm2 && { pm2: { id: 2, cli: '/fixture/pm2' }, env: { ...old.env, PM2_HOME: '/fixture/pm2-home' } }) };
  const files = { [`/proc/${old.pid}/cgroup`]: cgroup,
    ...(pm2 && { '/fixture/pm2-home/dump.pm2': JSON.stringify(dump) }) };
  const calls = [];
  const io = { userManagerEnvironment: async env => ({...env,XDG_RUNTIME_DIR:'/fixture/runtime',DBUS_SESSION_BUS_ADDRESS:'unix:path=/fixture/runtime/bus'}), capture: async (command, args) => {
    calls.push([command, ...args]);
    if (command === '/fixture/pm2') return JSON.stringify([{ pm_id: 2, pid: old.pid, name: 'old-bot',
      pm2_env: { pm_cwd: old.cwd, pm_exec_path: '/fixture/old/app.js' } }]);
    return Object.entries(service).map(([key, value]) => `${key}=${value}`).join('\n');
  } };
  const read = async path => {
    if (Object.hasOwn(files, path)) return files[path];
    throw Object.assign(Error('missing'), { code: 'ENOENT' });
  };
  return { snapshot, io, read, calls };
}

test('ordinary foreground SSH and user session do not imply bot autostart', async () => {
  for (const cgroup of ['0::/user.slice/user-1000.slice/session-9.scope\n',
    '0::/system.slice/sshd.service\n', '0::/user.slice/user-1000.slice/user@1000.service/app.slice/my-session.service\n']) {
    const x = environment({ cgroup, service: { MainPID: '99', ExecStart: '/usr/sbin/sshd', Restart: 'always', UnitFileState: 'enabled' } });
    const plan = await inspectLegacyBoot(x.snapshot, { env: {} }, x.io, { read: x.read });
    assert.equal(plan.status, 'not-configured');
    assert.equal(plan.newAutostartConfigured, false);
  }
});

test('actual direct bot system service blocks before handoff and identifies the unit', async () => {
  const x = environment({ cgroup: '0::/system.slice/my-yunzai.service\n', service: {
    MainPID: String(old.pid), ExecStart: '{ path=/usr/bin/node ; argv[]=/usr/bin/node app.js ; }', Restart: 'always', UnitFileState: 'enabled',
  } });
  const plan = await inspectLegacyBoot(x.snapshot, { env: {} }, x.io, { read: x.read });
  assert.equal(plan.status, 'handoff-required'); assert.equal(plan.reason, 'old-bot-service');
  assert.equal(plan.scope, 'system'); assert.equal(plan.unit, 'my-yunzai.service');
  assert.match(plan.inspectCommand, /^systemctl show my-yunzai\.service/u);
  assert.match(plan.message, /接管/u);
  assert.equal(Object.keys(plan).includes('properties'),false);
  assert.ok(x.calls.every(call => !call.includes('stop') && !call.includes('disable')));
});

test('same-user dedicated bot service is detected without editing the unit', async () => {
  const x = environment({ cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/bot.service\n', service: {
    MainPID: String(old.pid), ExecStart: '/usr/bin/node app.js', Restart: 'on-failure', UnitFileState: 'disabled',
  } });
  const plan = await inspectLegacyBoot(x.snapshot, { env: {} }, x.io, { read: x.read });
  assert.equal(plan.status, 'handoff-required'); assert.equal(plan.scope, 'user');
  assert.match(plan.inspectCommand, /^systemctl --user show bot\.service/u);
});

test('user unit inspection restores verified same-UID bus when the old service environment has none', async () => {
  const x=environment({cgroup:'0::/user.slice/user-1000.slice/user@1000.service/app.slice/bot.service\n'});
  x.io.userManagerEnvironment=async(env,uid)=>{
    assert.equal(uid,process.getuid());assert.equal(env.XDG_RUNTIME_DIR,undefined);
    return {...env,XDG_RUNTIME_DIR:'/verified/runtime',DBUS_SESSION_BUS_ADDRESS:'unix:path=/verified/runtime/bus'};
  };
  x.io.capture=async(_,args,options)=>{
    assert.ok(args.includes('--user'));assert.equal(options.env.DBUS_SESSION_BUS_ADDRESS,'unix:path=/verified/runtime/bus');
    return `MainPID=${old.pid}\nExecStart=/usr/bin/node app.js\nRestart=always\nUnitFileState=enabled`;
  };
  assert.equal((await inspectLegacyBoot(x.snapshot,{env:{}},x.io,{read:x.read})).status,'handoff-required');
});
test('unavailable bus or failed show for an actual cgroup business unit blocks before handoff', async () => {
  for(const noBus of [true,false]){
    const x=environment({cgroup:'0::/user.slice/user-1000.slice/user@1000.service/app.slice/bot.service\n'});
    if(noBus)x.io.userManagerEnvironment=async()=>{throw Error('no bus')};
    else x.io.capture=async()=>{throw Error('denied')};
    const plan=await inspectLegacyBoot(x.snapshot,{env:{}},x.io,{read:x.read});
    assert.equal(plan.status,'blocked');assert.equal(plan.unit,'bot.service');assert.equal(plan.reason,'unverified-old-service');
  }
});
test('missing user bus does not block inspecting an actual system unit',async()=>{
  const x=environment({cgroup:'0::/system.slice/bot.service\n',service:{MainPID:String(old.pid),ExecStart:'node app.js',Restart:'always',UnitFileState:'enabled'}});
  x.io.userManagerEnvironment=async()=>{throw Error('no bus')};
  assert.equal((await inspectLegacyBoot(x.snapshot,{env:{}},x.io,{read:x.read})).status,'handoff-required');
});
test('unreadable extra PM2 units outside the old process cgroup are recorded without blocking',async()=>{
  const x=environment({pm2:true,dump:[{name:'old-bot',pm_cwd:old.cwd,pm_exec_path:'/fixture/old/app.js'}],cgroup:'0::/user.slice/user-1000.slice/session-5.scope\n'});
  const original=x.io.capture;
  x.io.capture=async(command,args)=>{
    if(command==='/fixture/pm2')return original(command,args);
    if(args.includes('list-unit-files'))return 'pm2-other.service enabled enabled';
    throw Error('denied');
  };
  const plan=await inspectLegacyBoot(x.snapshot,{env:{}},x.io,{read:x.read});
  assert.equal(plan.status,'not-configured');assert.deepEqual(plan.unverifiedUnits,['pm2-other.service','pm2-other.service']);
});
test('a dedicated wrapper service is identified by verified MainPID rather than its script name', async () => {
  const x = environment({ cgroup: '0::/system.slice/start-wrapper.service\n', service: {
    MainPID: String(old.pid), ExecStart: '/fixture/launch-bot.sh', Restart: 'always', UnitFileState: 'disabled',
  } });
  assert.equal((await inspectLegacyBoot(x.snapshot, { env: {} }, x.io, { read: x.read })).status, 'handoff-required');
});

test('a wrapper MainPID may differ only with exact bot cgroup, source working directory and absolute entry', async () => {
  for (const working of [old.cwd, '/foreign']) {
    const x=environment({cgroup:'0::/system.slice/wrapped-bot.service/worker\n',service:{
      MainPID:'99',ExecStart:`/bin/sh -c "/usr/bin/node ${old.cwd}/app.js"`,WorkingDirectory:working,
      ControlGroup:'/system.slice/wrapped-bot.service',Restart:'always',UnitFileState:'enabled',
    }});
    const plan=await inspectLegacyBoot(x.snapshot,{env:{}},x.io,{read:x.read});
    assert.equal(plan.status,working===old.cwd?'handoff-required':'not-configured');
    if(working===old.cwd){assert.equal(plan.dedicated,true);assert.equal(plan.mainPid,99)}
  }
});

test('PM2 boot service blocks only with its exact home and saved old application', async () => {
  const record = { name: 'old-bot', pm_cwd: old.cwd, pm_exec_path: '/fixture/old/app.js' };
  for (const saved of [record, { ...record, pm_exec_path: '/fixture/another/app.js' }]) {
    const x = environment({ pm2: true, dump: [saved], cgroup: '0::/system.slice/pm2-user.service\n', service: {
      MainPID: '99', ExecStart: '/fixture/pm2 resurrect', Restart: 'on-failure', UnitFileState: 'enabled',
      Environment: 'PATH=/bin PM2_HOME=/fixture/pm2-home',
    } });
    const plan = await inspectLegacyBoot(x.snapshot, { env: {} }, x.io, { read: x.read });
    assert.equal(plan.status, saved === record ? 'handoff-required' : 'not-configured');
    if (saved === record) { assert.equal(plan.reason, 'persisted-old-pm2'); assert.equal(plan.pm2Home, '/fixture/pm2-home'); }
  }
});

test('PM2 shared daemon with no proven startup service does not block foreground deployments', async () => {
  const x = environment({ pm2: true, dump: [{ name: 'old-bot', pm_cwd: old.cwd, pm_exec_path: '/fixture/old/app.js' }],
    cgroup: '0::/user.slice/user-1000.slice/session-5.scope\n' });
  const plan = await inspectLegacyBoot(x.snapshot, { env: {} }, x.io, { read: x.read });
  assert.equal(plan.status, 'not-configured'); assert.equal(plan.persistedOldPm2, true);
});

test('saved old PM2 app plus enabled boot unit is detected even when its daemon was started in SSH', async () => {
  const x = environment({ pm2: true, dump: [{ name: 'old-bot', pm_cwd: old.cwd, pm_exec_path: '/fixture/old/app.js' }],
    cgroup: '0::/user.slice/user-1000.slice/session-5.scope\n' });
  const original = x.io.capture;
  x.io.capture = async (command, args) => {
    if (command === '/fixture/pm2') return original(command, args);
    if (args.includes('list-unit-files')) return args.includes('--user') ? '' : 'pm2-fixture.service enabled enabled';
    return 'MainPID=0\nExecStart=/fixture/pm2 resurrect\nRestart=on-failure\nUnitFileState=enabled\nEnvironment=PM2_HOME=/fixture/pm2-home';
  };
  const plan = await inspectLegacyBoot(x.snapshot, { env: {} }, x.io, { read: x.read });
  assert.equal(plan.status, 'handoff-required'); assert.equal(plan.unit, 'pm2-fixture.service');
  assert.equal(plan.scope, 'system'); assert.equal(plan.reason, 'persisted-old-pm2');
});

test('a valid PM2 primary dump takes precedence over an old backup and disabled records do not start', async () => {
  for (const dump of [[], [{ name: 'old-bot', pm_cwd: old.cwd, pm_exec_path: '/fixture/old/app.js', autostart: false }]]) {
    const x = environment({ pm2: true, dump, cgroup: '0::/system.slice/pm2-user.service\n', service: {
      MainPID: '99', ExecStart: '/fixture/pm2 resurrect', Restart: 'on-failure', UnitFileState: 'enabled',
      Environment: 'PM2_HOME=/fixture/pm2-home',
    } });
    const read = async path => path.endsWith('dump.pm2.bak')
      ? JSON.stringify([{ name: 'old-bot', pm_cwd: old.cwd, pm_exec_path: '/fixture/old/app.js' }]) : x.read(path);
    assert.equal((await inspectLegacyBoot(x.snapshot, { env: {} }, x.io, { read })).status, 'not-configured');
  }
});

test('PM2 preflight cleans only its private daemon even if readiness fails', async () => {
  const work = await mkdtemp(join(tmpdir(), 'lotus-pm2-preflight-'));
  const calls = [];
  try {
    await assert.rejects(prepareMigrationPm2(root, '/fixture/bun', work, { env: { PM2_HOME: '/must-not-touch', PM2_RPC_PORT: '/must-not-touch/rpc.sock' } }, {
      capture: async (...args) => { calls.push(args); throw Error('preflight failure'); },
      execute: async (...args) => { calls.push(args); },
    }), /preflight failure/u);
    assert.equal(calls.length, 2);
    assert.equal(calls[1][1].at(-1), 'kill');
    assert.ok(calls.every(call => call[2].env.PM2_HOME === join(work, 'pm2-preflight')));
    assert.ok(calls.every(call => call[2].env.PM2_RPC_PORT === undefined));
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('installed PM2 runs and stops a real isolated daemon using Bun without Node on PATH', {
  skip: !process.env.LOTUS_TEST_BUN, timeout: 40_000,
}, async () => {
  const work = await mkdtemp(join(tmpdir(), 'lotus-pm2-real-preflight-'));
  const run = promisify(execFile);
  const options = { cwd: root, env: { ...process.env, PATH: '/nonexistent-lotus-test-path' } };
  const live = { ...options, env: { ...options.env, PM2_HOME: join(work, 'pm2-preflight') }, timeout: 10_000 };
  const cli = [join(root, 'node_modules/pm2/bin/pm2')];
  try {
    const result = await prepareMigrationPm2(root, process.env.LOTUS_TEST_BUN, work, options, {
      capture: async (command, args, opts) => (await run(command, args, { ...opts, timeout: 25_000 })).stdout,
      execute: async (command, args, opts) => { await run(command, args, { ...opts, timeout: 10_000 }); },
    });
    assert.equal(result.available, true);
    const pid = await readFile(join(work, 'pm2-preflight/pm2.pid'), 'utf8').catch(() => '');
    assert.equal(pid, '');
    const config = join(work, 'fixture.json');
    await writeFile(config, JSON.stringify({ apps: [{ name: 'lotus-pm2-runtime-fixture', cwd: work,
      script: process.env.LOTUS_TEST_BUN, interpreter: 'none', args: ['--eval', 'setInterval(()=>{},1000)'],
      autorestart: false, pmx: false, vizion: false }] }));
    await run(process.env.LOTUS_TEST_BUN, [...cli, 'start', config], live);
    const state = await run(process.env.LOTUS_TEST_BUN, [...cli, 'jlist'], live);
    const apps = JSON.parse(state.stdout);
    assert.equal(apps[0].name, 'lotus-pm2-runtime-fixture');
    assert.equal(apps[0].pm2_env.status, 'online');
    assert.ok(apps[0].pid > 0);
    await run(process.env.LOTUS_TEST_BUN, [...cli, 'stop', 'lotus-pm2-runtime-fixture'], live);
  } finally {
    await run(process.env.LOTUS_TEST_BUN, [...cli, 'kill'], live).catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
});
