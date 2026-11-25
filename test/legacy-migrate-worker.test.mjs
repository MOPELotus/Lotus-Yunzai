import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { runLegacyMigration, processIdentity, updateMigrationState, prepareBun } from '../scripts/legacy-migrate.mjs';

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
test('旧进程恢复使用私有环境快照，而非已清理的worker环境', () => fixture(async x => {
  await updateMigrationState(x.statePath, { oldHost: { ...x.old, env: { NODE_OPTIONS: '--old-option', PM2_HOME: '/fixture/old-pm2' }, pm2: { id: 8, cli: '/fake/pm2' } } });
  let running = true;
  x.dependencies.identity = async pid => running ? { ...x.old, pid } : null;
  x.dependencies.capture = async (_, __, options) => {
    assert.equal(options.env.NODE_OPTIONS, '--old-option');
    return JSON.stringify([{ pm_id: 8, pid: x.old.pid, pm2_env: { status: 'online' } }]);
  };
  x.dependencies.execute = async (command, args, options) => {
    if (command === '/fake/pm2') {
      assert.equal(options.env.PM2_HOME, '/fixture/old-pm2');
      if (args[0] === 'stop') running = false;
      if (args[0] === 'restart') running = true;
    }
    if (args[1] === 'bootstrap') throw Error('fixture failure');
  };
  await assert.rejects(runLegacyMigration(x, x.dependencies));
  assert.equal(JSON.parse(await readFile(x.statePath, 'utf8')).recovery, 'old-restored');
}));

 test('自动安装Bun只修改隔离HOME，官方入口失败后有限回退', () => fixture(async x => {
  const work = join(x.source, 'isolated-install'), home = join(x.source, 'original-home');
  await mkdir(work, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFile(join(home, '.bashrc'), 'untouched');
  const executable = join(work, 'bun/bin/bun'), urls = [];
  const installer = `#!/bin/sh
set -e
[ "$SHELL" = /bin/sh ]
[ "$XDG_CONFIG_HOME" = "$HOME/.config" ]
printf private-install >> "$HOME/.bashrc"
mkdir -p "$BUN_INSTALL/bin"
printf '#!/bin/sh\\nprintf 1.4.4' > "$BUN_INSTALL/bin/bun"
chmod 700 "$BUN_INSTALL/bin/bun"
`;
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash' };
  const bun = await prepareBun(work, { cwd: work, env, log: 1 }, { candidates: [executable],
    capture: async (command, args) => {
      if (command === 'curl') {
        urls.push(args.at(-1));
        if (urls.length === 1) throw Error('fixture TLS');
        await writeFile(args[args.indexOf('--output') + 1], installer);
        return 'https://bun.sh/install';
      }
      const result = spawnSync(command, args, { encoding: 'utf8' });
      if (result.error || result.status !== 0) throw Error('not installed');
      return result.stdout.trim();
    },
  });
  assert.equal(bun, executable);
  assert.deepEqual(urls, ['https://bun.com/install', 'https://bun.sh/install']);
  assert.equal(await readFile(join(home, '.bashrc'), 'utf8'), 'untouched');
  assert.equal(await readFile(join(work, 'install-home/.bashrc'), 'utf8'), 'private-install');
  assert.equal(env.HOME, home); assert.equal(env.SHELL, '/bin/bash');
}));

test('真实Node CLI批准交接，仓库根目录尾斜杠不误判不安全', () => fixture(async x => {
  await updateMigrationState(x.statePath, { phase: 'ready-to-stop', marker: 'preserved' });
  const worker = new URL('../scripts/legacy-migrate.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [worker.pathname, '--approve', '--source', x.source, '--state', x.statePath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const approved = JSON.parse(await readFile(x.statePath, 'utf8'));
  assert.equal(approved.handoffApproved, true); assert.equal(approved.marker, 'preserved');
  assert.equal(approved.phase, 'ready-to-stop'); assert.equal(x.running(), true);
}));
test('真实PM2 CLI输出版本banner时仍识别尾部jlist进程数组', () => fixture(async x => {
  await updateMigrationState(x.statePath, { oldHost: { ...x.old, pm2: { id: 9, cli: process.execPath } } });
  await writeFile(join(x.source, 'jlist'), `console.log('>>>> In-memory PM2 is out-of-date');console.log(JSON.stringify([{pm_id:9,pid:${x.old.pid},pm2_env:{status:'online'}}]));`);
  let running = true;
  delete x.dependencies.capture;
  x.dependencies.identity = async pid => running ? { ...x.old, pid } : null;
  x.dependencies.execute = async (_, args) => {
    if (args[0] === 'stop') running = false;
    if (args[0] === 'restart') running = true;
    if (args[1] === 'bootstrap') throw Error('fixture failure');
  };
  await assert.rejects(runLegacyMigration(x, x.dependencies));
  assert.equal(JSON.parse(await readFile(x.statePath, 'utf8')).recovery, 'old-restored');
}));

test('真实Node改title后使用restoreArgv恢复，不能以空身份argv启动', () => fixture(async x => {
  const script = join(x.source, 'titled.mjs'), marker = join(x.source, 'running.json');
  await writeFile(script, `import{writeFile}from'node:fs/promises';process.title='lotus-title-fixture';await writeFile(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [script], { cwd: x.source, stdio: 'ignore' });
  await once(child, 'spawn');
  let restoredPid;
  try {
    for(let i=0;i<100&&!await readFile(marker).catch(()=>null);i++)await new Promise(done=>setTimeout(done,10));
    const original = await processIdentity(child.pid);
    assert.deepEqual(original.argv, []);
    await updateMigrationState(x.statePath, { oldHost: { ...original, restoreArgv: [script] } });
    delete x.dependencies.identity; delete x.dependencies.kill; delete x.dependencies.restore;
    x.dependencies.sleep = async ms => {
      const state = JSON.parse(await readFile(x.statePath, 'utf8'));
      if (state.phase === 'ready-to-stop') await updateMigrationState(x.statePath, { handoffApproved: true });
      await new Promise(done=>setTimeout(done,Math.min(ms,100)));
    };
    x.dependencies.execute = async (_,args) => { if(args[1]==='bootstrap')throw Error('fixture failure'); };
    await assert.rejects(runLegacyMigration(x, x.dependencies));
    assert.equal(JSON.parse(await readFile(x.statePath, 'utf8')).recovery, 'old-restored');
    restoredPid=JSON.parse(await readFile(marker,'utf8')).pid;
    assert.notEqual(restoredPid, child.pid); assert.ok(await processIdentity(restoredPid));
  }finally{
    if(restoredPid)try{process.kill(restoredPid,'SIGTERM')}catch{}
    if(child.exitCode===null&&!child.killed)child.kill('SIGTERM');
  }
}));
test('清除整套PM2运行元数据，保留代理、Git、Bun、npm及XDG环境', async () => {
  const { migrationEnvironment } = await import('../scripts/legacy-migrate-environment.mjs');
  const operational = Object.fromEntries(`name watch autorestart autostart exec_mode namespace instances cwd args script
    exec_interpreter node_args pm_id pm_exec_path pm_cwd pm_pid_path created_at status restart_time prev_restart_delay
    pm_uptime axm_actions env env_production instance_var max_restarts stop_exit_codes node_version username unique_id
    vizion vizion_running automation time kill_timeout log_date_format merge_logs PM2_HOME PM2_USAGE PM2_INTERACTOR_PROCESSING
    NODE_APP_INSTANCE NODE_OPTIONS NODE_CHANNEL_FD LOTUS_PROFILE_DIR`.split(/\s+/u).map(key=>[key,'old']));
  const retained = {PATH:'/bin',HOME:'/home/fixture',HTTP_PROXY:'http://proxy.invalid',https_proxy:'http://proxy.invalid',
    GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'protocol.file.allow',GIT_CONFIG_VALUE_0:'always',BUN_INSTALL_CACHE_DIR:'/fixture/cache',
    npm_config_cache:'/fixture/npm',XDG_CACHE_HOME:'/fixture/xdg',NODE_COMPILE_CACHE:'/fixture/node',TZ:'Asia/Shanghai'};
  assert.deepEqual(migrationEnvironment({...retained,...operational}),retained);
});
test('启动新端不继承旧PM2名称和watch，旧端恢复仍用原始元数据', () => fixture(async x => {
  const previous={name:process.env.name,watch:process.env.watch,autorestart:process.env.autorestart};
  Object.assign(process.env,{name:'lotus-legacy-v2',watch:'true',autorestart:'true'});
  try {
    await updateMigrationState(x.statePath,{oldHost:{...x.old,env:{...process.env},pm2:{id:9,cli:'/fake/pm2'}}});
    let running=true;
    x.dependencies.identity=async pid=>running?{...x.old,pid}:null;
    x.dependencies.capture=async()=>JSON.stringify([{pm_id:9,pid:x.old.pid,pm2_env:{status:'online'}}]);
    x.dependencies.execute=async(command,args,options)=>{
      if(command==='/fake/pm2'){
        assert.equal(options.env.name,'lotus-legacy-v2');assert.equal(options.env.watch,'true');
        if(args[0]==='stop')running=false;if(args[0]==='restart')running=true;
      }else{
        assert.equal(options.env.name,undefined);assert.equal(options.env.watch,undefined);assert.equal(options.env.autorestart,undefined);
      }
      if(args[1]==='start:bg')throw Error('fixture startup failure');
    };
    await assert.rejects(runLegacyMigration(x,x.dependencies));
    assert.equal(JSON.parse(await readFile(x.statePath,'utf8')).recovery,'old-restored');
  }finally{for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value}}
}));
