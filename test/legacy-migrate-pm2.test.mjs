import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { jsonArraySlices, preparePm2Takeover } from '../scripts/legacy-migrate-pm2.mjs';

test('JSON array patch ranges retain arbitrary nested strings, escapes and unrelated whitespace', () => {
  const raw = '[\n { "foreign": "[a, \\\"b\\\"]", "future":[1,{"x":"]"}] } ,\n {"old":true}\n]';
  const ranges = jsonArraySlices(raw);
  assert.equal(ranges.length, 2);
  const second = ranges[1];
  const patched = raw.slice(0, second.start) + '{"new":true}' + raw.slice(second.end);
  assert.deepEqual(JSON.parse(patched), [ranges[0].value, { new: true }]);
  assert.equal(patched.slice(0, second.start), raw.slice(0, second.start));
});

async function fixture(run) {
  const parent = await mkdtemp(join(tmpdir(), 'lotus-pm2-takeover-'));
  const home = join(parent, 'shared-pm2'), source = join(parent, 'old'), target = join(parent, 'new'), work = join(parent, 'work');
  try {
    for (const path of [home, source, target, work, join(target, 'data')]) await mkdir(path, { mode: 0o700 });
    const oldEnv = { pm_cwd: source, pm_exec_path: join(source, 'old.js'), exec_interpreter: '/fixture/node', status: 'online',
      args: ['--fixture'], env: { BUSINESS: 'original' }, unknownFuture: { untouched: true } };
    const foreign = { name: 'other-service', pm_cwd: '/foreign', pm_exec_path: '/foreign/app.js',
      status: 'online', future: { whitespace: '[a, "b"]', values: [1, 2, 3] } };
    const original = { name: 'my-existing-bot', ...oldEnv };
    const foreignText = '{ "name":"other-service", "pm_cwd":"/foreign", "pm_exec_path":"/foreign/app.js", "status":"online", "future":{"whitespace":"[a, \\\"b\\\"]","values":[1,2,3]} }';
    const raw = '[\n  ' + foreignText + ',\n ' + JSON.stringify(original) + '\n]\n';
    const dump = join(home, 'dump.pm2');
    await writeFile(dump, raw, { mode: 0o600 });
    let rows = [{ name: original.name, pm_id: 4, pid: 123, pm2_env: structuredClone(oldEnv) },
      { name: 'other-service', pm_id: 5, pid: 999, pm2_env: { pm_cwd: '/foreign', pm_exec_path: '/foreign/app.js', status: 'online' } }];
    const old = { pid: 123, cwd: source, execPath: '/fixture/node', argv: [join(source, 'old.js')],
      env: { PM2_HOME: home, HOME: parent, BUSINESS: 'original' }, pm2: { id: 4, cli: '/fixture/pm2' } };
    const stateHome = join(parent, '.new.lotus-pm2');
    const calls = [];
    const io = {
      capture: async () => JSON.stringify(rows),
      execute: async (command, args) => {
        calls.push([command, ...args]);
        if (command === '/fixture/pm2') {
          const id = Number(args[1]);
          const record = rows.find(row => row.pm_id === id);
          if (args[0] === 'stop') { record.pid = 0; record.pm2_env.status = 'stopped'; }
          if (args[0] === 'delete') rows = rows.filter(row => row.pm_id !== id);
          if (args[0] === 'restart') { record.pid = 789; record.pm2_env.status = 'online'; }
          if (args[0] === 'start') {
            const configured = JSON.parse(await readFile(args[1], 'utf8')).apps[0];
            rows.push({ name: original.name, pm_id: 11, pid: 789, pm2_env: { ...configured,
              pm_cwd: configured.cwd, pm_exec_path: configured.script, status: 'online' } });
          }
        } else if (args[1] === 'start:bg') {
          await mkdir(stateHome, { mode: 0o700 });
          await writeFile(join(stateHome, 'host-ready'), '456');
          await writeFile(join(stateHome, 'host-start-attempt'), 'fixture-token');
          rows.push({ name: original.name, pm_id: 8, pid: 456, pm2_env: { name: original.name, status: 'online',
            pm_cwd: dirname(target), pm_exec_path: '/fixture/bun', exec_interpreter: 'none',
            args: ['--no-env-file', join(stateHome, 'host-entry.js'), target, join(stateHome, 'host-ready'), 'fixture-token'],
            env: { LOTUS_PM2_START_TOKEN: 'fixture-token' } } });
        } else if (args[1] === 'stop') {
          const entry = rows.find(row => row.pm_id === 8);
          if (entry) { entry.pid = 0; entry.pm2_env.status = 'stopped'; }
        }
      },
    };
    const plan = { pm2Home: home, scope: 'system', unit: 'pm2-user.service', unitFileState:'enabled' };
    const options = { cwd: target, env: { HOME: parent } };
    await run({ parent, home, source, target, work, old, plan, options, io, dump, original, foreignText, raw,
      calls, rows: () => rows });
  } finally { await rm(parent, { recursive: true, force: true }); }
}

test('shared PM2 takeover replaces only old bot persistence and keeps other live app and raw record bytes', () => fixture(async x => {
  const controller = await preparePm2Takeover(x.plan, x.old, x.target, '/fixture/bun', x.work, x.options, x.io);
  await controller.stopOld(); await controller.startNew();
  assert.equal(controller.report().newAutostartConfigured, true);
  const actual = await readFile(x.dump, 'utf8');
  assert.ok(actual.includes(x.foreignText));
  const records = JSON.parse(actual);
  assert.equal(records[1].pm_exec_path, '/fixture/bun');
  assert.equal(records[1].unknownFuture.untouched, true);
  assert.equal(x.rows().find(row => row.pm_id === 5).pid, 999);
  assert.equal(x.rows().find(row => row.pm_id === 5).pm2_env.status, 'online');
  const mapping = JSON.parse(await readFile(join(x.target, 'data/pm2-handoff.json'), 'utf8'));
  assert.equal(mapping.home, x.home); assert.equal(mapping.name, x.original.name); assert.equal(mapping.root, x.target);
  assert.equal((await lstat(join(x.work, 'pm2-takeover/dump.pm2'))).mode & 0o777, 0o600);
  assert.ok(!x.calls.some(call => call[1] === 'save' || call[1] === 'kill'));
}));

test('rollback restores original bot and its row while retaining later edits to unrelated rows', () => fixture(async x => {
  const controller = await preparePm2Takeover(x.plan, x.old, x.target, '/fixture/bun', x.work, x.options, x.io);
  await controller.stopOld(); await controller.startNew();
  const records = JSON.parse(await readFile(x.dump, 'utf8')); records[0].future.external = 'new';
  await writeFile(x.dump, JSON.stringify(records));
  await controller.rollback();
  const restored = JSON.parse(await readFile(x.dump, 'utf8'));
  assert.equal(restored[0].future.external, 'new'); assert.deepEqual(restored[1], x.original);
  assert.equal(x.rows().find(row => row.name === x.original.name).pm2_env.pm_cwd, x.source);
  assert.equal(x.rows().find(row => row.name === x.original.name).pid, 789);
  assert.equal(x.rows().find(row => row.pm_id === 5).pid, 999);
  assert.equal(controller.report().status, 'rolled-back');
}));

test('external mutation of the target row is rejected instead of clobbered', () => fixture(async x => {
  const controller = await preparePm2Takeover(x.plan, x.old, x.target, '/fixture/bun', x.work, x.options, x.io);
  await controller.stopOld();
  const records = JSON.parse(await readFile(x.dump, 'utf8')); records[1].unknownFuture.external = 'preserve';
  await writeFile(x.dump, JSON.stringify(records));
  await assert.rejects(controller.startNew(), /外部修改/u);
  assert.equal(JSON.parse(await readFile(x.dump, 'utf8'))[1].unknownFuture.external, 'preserve');
  await controller.rollback();
  assert.equal(JSON.parse(await readFile(x.dump, 'utf8'))[1].unknownFuture.external, 'preserve');
  assert.equal(x.rows().find(row => row.pm_id === 5).pid, 999);
}));

test('rollback revalidates a reassigned old id and never restarts the foreign application now using it', () => fixture(async x => {
  const controller=await preparePm2Takeover(x.plan,x.old,x.target,'/fixture/bun',x.work,x.options,x.io);
  await controller.stopOld();
  x.rows().find(row=>row.pm_id===4).pm_id=44;
  const foreign={name:'new-foreign',pm_id:4,pid:777,pm2_env:{pm_cwd:'/foreign',pm_exec_path:'/foreign/new.js',status:'online'}};
  x.rows().push(foreign);
  await assert.rejects(controller.startNew(),/身份/u);
  await controller.rollback();
  assert.equal(foreign.pid,777);assert.equal(foreign.pm2_env.status,'online');
  assert.ok(x.calls.some(call=>call[1]==='restart'&&call[2]==='44'));
  assert.ok(!x.calls.some(call=>call[1]==='restart'&&call[2]==='4'));
}));

test('a pre-existing target mapping survives failure without being deleted by rollback',()=>fixture(async x=>{
  const controller=await preparePm2Takeover(x.plan,x.old,x.target,'/fixture/bun',x.work,x.options,x.io);
  const path=join(x.target,'data/pm2-handoff.json');await writeFile(path,'private existing mapping');
  await controller.stopOld();await assert.rejects(controller.startNew());await controller.rollback();
  assert.equal(await readFile(path,'utf8'),'private existing mapping');
}));

test('an unchanged disabled startup unit stays disabled rather than claiming new boot autostart',()=>fixture(async x=>{
  const controller=await preparePm2Takeover({...x.plan,unitFileState:'disabled'},x.old,x.target,'/fixture/bun',x.work,x.options,x.io);
  await controller.stopOld();await controller.startNew();
  assert.equal(controller.report().status,'completed');assert.equal(controller.report().newAutostartConfigured,false);
}));
