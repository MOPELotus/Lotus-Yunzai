import { readFile, writeFile, mkdir, rename, rm, lstat, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrationEnvironment } from './legacy-migrate-environment.mjs';

const catalog = JSON.parse(await readFile(new URL('../i18n/legacy-migrate/zh-CN.json', import.meta.url), 'utf8')).messages;
const text = key => catalog[key] || key;
const fail = key => { throw Error(text(key)); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Locate array elements without reserializing any unrelated record or whitespace. */
export function jsonArraySlices(raw) {
  const value = JSON.parse(raw);
  if (!Array.isArray(value)) fail('pm2_snapshot');
  let index = raw.indexOf('[') + 1;
  const slices = [];
  for (const item of value) {
    while (/\s/u.test(raw[index] || '')) index++;
    const start = index;
    let depth = 0, quoted = false, escaped = false;
    for (; index < raw.length; index++) {
      const char = raw[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '[' || char === '{') depth++;
      else if (char === ']' || char === '}') { if (depth === 0) break; depth--; }
      else if (char === ',' && depth === 0) break;
    }
    let end = index;
    while (end > start && /\s/u.test(raw[end - 1])) end--;
    slices.push({ value: item, start, end });
    if (raw[index] === ',') index++;
  }
  return slices;
}

async function snapshot(path) {
  const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!info) return;
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.size > 64 * 1024 * 1024 ||
      await realpath(path) !== path) fail('pm2_snapshot');
  return { path, bytes: await readFile(path), mode: info.mode & 0o777 };
}

async function atomicCompareWrite(path, expected, next, mode) {
  const before = await snapshot(path);
  if (!before || !before.bytes.equals(expected)) fail('pm2_conflict');
  const temporary = path + '.lotus-' + randomUUID();
  try {
    await writeFile(temporary, next, { mode, flag: 'wx' });
    const check = await snapshot(path);
    if (!check || !check.bytes.equals(expected)) fail('pm2_conflict');
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function preparePm2Takeover(plan, old, target, bun, work, options, io) {
  if (!old.pm2?.cli?.startsWith('/') || /[\r\n\0]/u.test(old.pm2.cli)) fail('pm2_namespace');
  const oldOptions = { ...options, env: old.env || options.env, cwd: old.cwd };
  const command = (args, recovery = false) => io.execute(old.pm2.cli, args, { ...oldOptions, ...(recovery && { signal: undefined }) });
  const list = async () => {
    const raw = await io.capture(old.pm2.cli, ['jlist'], oldOptions);
    return io.parsePm2ProcessList ? io.parsePm2ProcessList(raw) : JSON.parse(raw);
  };
  const initial = (await list()).find(row => String(row.pm_id) === String(old.pm2.id) && row.pid === old.pid);
  if (!initial?.pm2_env?.pm_exec_path || initial.pm2_env.pm_cwd !== old.cwd || !initial.name || /[\\/\r\n\0]/u.test(initial.name)) fail('pm2_identity');
  const home = await realpath(plan.pm2Home);
  const homeInfo = await lstat(home);
  if (!homeInfo.isDirectory() || homeInfo.uid !== process.getuid?.() || homeInfo.mode & 0o022) fail('pm2_permissions');
  await access(home, constants.W_OK | constants.X_OK);
  const backup = join(work, 'pm2-takeover');
  await mkdir(backup, { mode: 0o700 });
  await writeFile(join(backup, 'old-process.json'), JSON.stringify(initial) + '\n', { mode: 0o600, flag: 'wx' });
  const owns = row => row && row.name === initial.name && row.pm_cwd === initial.pm2_env.pm_cwd && row.pm_exec_path === initial.pm2_env.pm_exec_path;
  const dumps = [];
  for (const filename of ['dump.pm2', 'dump.pm2.bak']) {
    const saved = await snapshot(join(home, filename));
    if (!saved) continue;
    let slices;
    try { slices = jsonArraySlices(saved.bytes.toString('utf8')); } catch { continue; }
    const matched = slices.filter(row => owns(row.value));
    if (matched.length > 1) fail('pm2_identity');
    if (!matched.length) continue;
    await access(saved.path, constants.W_OK);
    await writeFile(join(backup, filename), saved.bytes, { mode: 0o600, flag: 'wx' });
    dumps.push({ ...saved, original: matched[0].value });
  }
  if (!dumps.length) fail('pm2_snapshot');
  const mapping = { format: 1, root: resolve(target), home, name: initial.name, cli: old.pm2.cli,
    ...(old.env?.PM2_RPC_PORT && { rpcSocket: old.env.PM2_RPC_PORT }),
    ...(old.env?.PM2_PUB_PORT && { pubSocket: old.env.PM2_PUB_PORT }) };
  if ([mapping.rpcSocket, mapping.pubSocket].some(path => path !== undefined && (!path.startsWith('/') || /[\r\n\0]/u.test(path)))) fail('pm2_namespace');
  const mapFile = join(target, 'data/pm2-handoff.json');
  const mappingBytes = JSON.stringify(mapping) + '\n';
  const stateHome = join(dirname(target), `.${basename(target)}.lotus-pm2`);
  let oldDeleted = false, startedNew = false, mappingWritten = false, status = 'prepared';
  const changedDumps = [];
  const newOwns = row => row?.name === initial.name && row.pm2_env?.pm_cwd === dirname(target) &&
    Array.isArray(row.pm2_env.args) && row.pm2_env.args[2] === target &&
    row.pm2_env.args[1] === join(stateHome, 'host-entry.js');
  const sameOld = row => row?.name === initial.name && row.pm2_env?.pm_cwd === initial.pm2_env.pm_cwd &&
    row.pm2_env?.pm_exec_path === initial.pm2_env.pm_exec_path;
  const report = () => ({ status, mode: 'pm2', scope: plan.scope, unit: plan.unit, pm2Home: home,
    name: initial.name, unitFileState: plan.unitFileState,
    newAutostartConfigured: status === 'completed' && /^(?:enabled|generated)$/u.test(plan.unitFileState || '') });
  return {
    report,
    async stopOld() {
      const current = (await list()).find(row => String(row.pm_id) === String(old.pm2.id));
      if (!sameOld(current) || current.pid !== old.pid || current.pm2_env.status !== 'online') fail('pm2_identity');
      await command(['stop', String(old.pm2.id)]);
      status = 'old-stopped';
    },
    async startNew() {
      const current = (await list()).find(row => String(row.pm_id) === String(old.pm2.id));
      if (!sameOld(current) || current.pid > 0 || current.pm2_env.status !== 'stopped') fail('pm2_identity');
      await writeFile(mapFile, mappingBytes, { mode: 0o600, flag: 'wx' });
      mappingWritten = true;
      await command(['delete', String(old.pm2.id)]);
      oldDeleted = true;
      startedNew = true;
      await io.execute(bun, ['run', 'start:bg'], options);
      const entries = (await list()).filter(newOwns);
      if (entries.length !== 1 || entries[0].pm2_env.status !== 'online' || entries[0].pid <= 0) fail('pm2_start');
      const token = entries[0].pm2_env?.env?.LOTUS_PM2_START_TOKEN;
      if (typeof token !== 'string' || (await readFile(join(stateHome, 'host-ready'), 'utf8')).trim() !== String(entries[0].pid) ||
          (await readFile(join(stateHome, 'host-start-attempt'), 'utf8')) !== token) fail('pm2_start');
      for (const dump of dumps) {
        const latest = await snapshot(dump.path);
        if (!latest) fail('pm2_conflict');
        const raw = latest.bytes.toString('utf8');
        const slices = jsonArraySlices(raw).filter(row => owns(row.value));
        if (slices.length !== 1 || !equal(slices[0].value, dump.original)) fail('pm2_conflict');
        const replacement = { ...dump.original, ...entries[0].pm2_env, name: initial.name };
        delete replacement.pm_id; delete replacement.instances; delete replacement.prev_restart_delay;
        const next = Buffer.from(raw.slice(0, slices[0].start) + JSON.stringify(replacement) + raw.slice(slices[0].end));
        await atomicCompareWrite(dump.path, latest.bytes, next, dump.mode);
        changedDumps.push({ dump, replacement });
      }
      status = 'completed';
    },
    async stopNew() {
      if (!startedNew) return;
      if (!mappingWritten || await readFile(mapFile, 'utf8').catch(() => undefined) !== mappingBytes) fail('pm2_conflict');
      await io.execute(bun, ['run', 'stop'], { ...options, signal: undefined });
      const entries = (await list()).filter(newOwns);
      if (entries.length > 1 || entries.some(entry => entry.pid > 0 || entry.pm2_env.status !== 'stopped')) fail('pm2_rollback');
    },
    async rollback() {
      if (mappingWritten && await readFile(mapFile, 'utf8').catch(() => undefined) !== mappingBytes) fail('pm2_conflict');
      if (startedNew) {
        await io.execute(bun, ['run', 'stop'], { ...options, signal: undefined });
        const entry = (await list()).find(newOwns);
        if (entry) {
          if (entry.pid > 0 || entry.pm2_env.status !== 'stopped') fail('pm2_rollback');
          await command(['delete', String(entry.pm_id)], true);
        }
      }
      for (const { dump, replacement } of changedDumps.reverse()) {
        const latest = await snapshot(dump.path);
        if (!latest) fail('pm2_conflict');
        const raw = latest.bytes.toString('utf8');
        const slices = jsonArraySlices(raw).filter(row => row.value?.name === initial.name && equal(row.value, replacement));
        if (slices.length !== 1) fail('pm2_conflict');
        await atomicCompareWrite(dump.path, latest.bytes, Buffer.from(raw.slice(0, slices[0].start) +
          JSON.stringify(dump.original) + raw.slice(slices[0].end)), dump.mode);
      }
      if (mappingWritten) await rm(mapFile, { force: true });
      if (oldDeleted) {
        const existing = (await list()).filter(row => row.name === initial.name);
        if (existing.length && (existing.length !== 1 || !sameOld(existing[0]))) fail('pm2_identity');
        const restore = join(backup, 'restore-old.json');
        const previousEnv = old.env || initial.pm2_env.env || {};
        const environment = { ...migrationEnvironment(previousEnv), ...Object.fromEntries(Object.entries(previousEnv)
          .filter(([key]) => key.startsWith('LOTUS_') || key === 'NODE_OPTIONS')) };
        const configured = { ...initial.pm2_env, name: initial.name,
          script: initial.pm2_env.pm_exec_path, cwd: initial.pm2_env.pm_cwd,
          interpreter: initial.pm2_env.exec_interpreter, env: environment };
        delete configured.pm_id; delete configured.prev_restart_delay;
        await writeFile(restore, JSON.stringify({ apps: [configured] }), { mode: 0o600 });
        if (!existing.length) await command(['start', restore, '--only', initial.name], true);
        else if (existing[0].pid <= 0 || existing[0].pm2_env.status !== 'online') await command(['restart', String(existing[0].pm_id)], true);
      } else {
        const originals = (await list()).filter(sameOld);
        if (originals.length !== 1) fail('pm2_identity');
        if (originals[0].pid <= 0 || originals[0].pm2_env.status !== 'online') await command(['restart', String(originals[0].pm_id)], true);
      }
      const restored = (await list()).filter(sameOld);
      if (restored.length !== 1 || restored[0].pid <= 0 || restored[0].pm2_env.status !== 'online') fail('pm2_rollback');
      status = 'rolled-back';
    },
  };
}
