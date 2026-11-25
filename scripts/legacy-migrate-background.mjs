import { readFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { userManagerEnvironment } from './legacy-migrate-systemd.mjs';

const catalog = JSON.parse(await readFile(new URL('../i18n/legacy-migrate/zh-CN.json', import.meta.url), 'utf8')).messages;
const text = key => catalog[key] || key;

/** Verify the installed CLI and its daemon in a private namespace before stopping the old bot. */
export async function prepareMigrationPm2(target, bun, work, options, io) {
  options.signal?.throwIfAborted();
  const script = join(target, 'node_modules/pm2/bin/pm2');
  const entry = await lstat(script).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!entry?.isFile()) throw Error(text('background_failed'));
  const home = join(work, 'pm2-preflight');
  await mkdir(home, { mode: 0o700, recursive: true });
  const homeInfo = await lstat(home);
  if (!homeInfo.isDirectory() || homeInfo.uid !== process.getuid?.() || homeInfo.mode & 0o077 || await realpath(home) !== home) {
    throw Error(text('background_failed'));
  }
  const clean = Object.fromEntries(Object.entries(options.env).filter(([key]) => !key.startsWith('PM2_')));
  const isolated = { ...options, env: { ...clean, PM2_HOME: home } };
  const controller = new AbortController();
  const interrupt = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', interrupt, { once: true });
  const timeout = setTimeout(() => controller.abort(Error(text('background_failed'))), 30_000);
  try {
    const response = await io.capture(bun, [script, 'ping'], { ...isolated, signal: controller.signal });
    if (!/\bpong\b/iu.test(response)) throw Error(text('background_failed'));
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', interrupt);
    // Never issue kill against the caller's PM2_HOME or the new production namespace.
    await io.execute(bun, [script, 'kill'], { ...isolated, signal: AbortSignal.timeout(10_000) });
  }
  return { available: true, provider: 'project-dependency', script };
}

function parseShow(output) {
  return Object.fromEntries(output.split(/\r?\n/u).flatMap(line => {
    const index = line.indexOf('=');
    return index < 1 ? [] : [[line.slice(0, index), line.slice(index + 1)]];
  }));
}

async function optionalRead(read, path) {
  try { return await read(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
}

/** Inspect only: no unit edits, enable/disable, daemon start, or shared PM2 dump writes. */
export async function inspectLegacyBoot(old, options, io, { read = readFile } = {}) {
  const cgroup = await optionalRead(read, `/proc/${old.pid}/cgroup`);
  if (!cgroup) return { status: 'not-configured', newAutostartConfigured: false };
  const userCgroup = cgroup.includes('/user.slice/') && !cgroup.includes('/system.slice/');
  const units = [...new Set([...cgroup.matchAll(/(?:^|\/)([A-Za-z0-9_.@:\\-]+\.service)(?=\/|\n|$)/gu)].map(match => match[1]))]
    .filter(unit => !/^(?:user@\d+|session[-@].*|ssh|sshd|systemd[-@].*)\.service$/u.test(unit))
    .map(unit => ({ unit, user: userCgroup, owned: true }));
  const managerEnvironment = async user => user
    ? userManagerEnvironment(old.env || options.env, process.getuid(), io)
    : old.env || options.env;
  let persistedOldPm2 = false;
  let pm2Home;
  const unverifiedUnits = [];
  if (old.pm2) {
    pm2Home = old.env?.PM2_HOME || join(old.env?.HOME || options.env.HOME || '', '.pm2');
    const rawList = await io.capture(old.pm2.cli, ['jlist'], { ...options, env: old.env || options.env });
    const rows = io.parsePm2ProcessList ? io.parsePm2ProcessList(rawList) : JSON.parse(rawList);
    const current = Array.isArray(rows) && rows.find(row => String(row.pm_id) === String(old.pm2.id) && row.pid === old.pid);
    for (const file of ['dump.pm2', 'dump.pm2.bak']) {
      const raw = await optionalRead(read, join(pm2Home, file));
      if (!raw || !current?.pm2_env?.pm_exec_path || !current.pm2_env.pm_cwd) continue;
      let saved;
      try { saved = JSON.parse(raw); } catch { continue; }
      if (!Array.isArray(saved)) continue;
      persistedOldPm2 = saved.some(row => row && row.autostart !== false && row.pm_cwd === current.pm2_env.pm_cwd &&
        row.pm_exec_path === current.pm2_env.pm_exec_path && row.name === current.name);
      // PM2 only falls back to .bak if its primary dump is missing or unparsable.
      break;
    }
  }
  if (persistedOldPm2) {
    // A PM2 daemon started manually may not currently belong to its enabled
    // boot unit. Inspect standard PM2 startup units as well as the live cgroup.
    for (const user of [false, true]) {
      try {
        const output = await io.capture('systemctl', [...(user ? ['--user'] : []), 'list-unit-files', 'pm2*.service',
          '--state=enabled,enabled-runtime', '--no-legend', '--no-pager'],
        { ...options, env: await managerEnvironment(user), signal: AbortSignal.timeout(5_000) });
        for (const line of output.split(/\r?\n/u)) {
          const match = /^([A-Za-z0-9_.@:\\-]+\.service)\s+enabled(?:-runtime)?(?:\s|$)/u.exec(line);
          if (match && !units.some(candidate => candidate.unit === match[1] && candidate.user === user)) units.push({ unit: match[1], user });
        }
      } catch { options.signal?.throwIfAborted(); }
    }
  }
  for (const { unit, user, owned } of units) {
    let properties;
    try {
      properties = parseShow(await io.capture('systemctl', [...(user ? ['--user'] : []), 'show', unit,
        '--property=MainPID', '--property=Restart', '--property=ExecStart', '--property=UnitFileState', '--property=Environment',
        '--property=WorkingDirectory', '--property=ControlGroup', '--property=Type', '--property=FragmentPath', '--property=User', '--no-pager'],
      { ...options, env: await managerEnvironment(user), signal: AbortSignal.timeout(5_000) }));
      if (!properties.MainPID || !properties.ExecStart || !properties.UnitFileState) throw Error(text('systemd_identity'));
    } catch {
      options.signal?.throwIfAborted();
      unverifiedUnits.push(unit);
      if (owned) return { status: 'blocked', newAutostartConfigured: false, unit, scope: user ? 'user' : 'system',
        reason: 'unverified-old-service', unverifiedUnits, message: `${text('systemd_preflight')} ${unit}` };
      continue;
    }
    const activeRestart = properties.Restart && properties.Restart !== 'no';
    const bootEnabled = /^(?:enabled|enabled-runtime|generated)$/u.test(properties.UnitFileState || '');
    // Equality with the already-verified old bot also covers ExecStart wrappers
    // that exec Node. SSH/session/container managers have a different MainPID.
    const entryArguments = [...(old.restoreArgv || []), ...(old.argv || [])].filter(value =>
      typeof value === 'string' && !value.startsWith('-') && /\.(?:[cm]?js|ts|sh)$/u.test(value));
    const entries = entryArguments.map(value => resolve(old.cwd, value));
    const group = properties.ControlGroup;
    const sameGroup = group && cgroup.split(/\r?\n/u).some(line => {
      const path = /^[^:]*:[^:]*:(.*)$/u.exec(line)?.[1];
      return path === group || path?.startsWith(group + '/');
    });
    const wrapperManaged = sameGroup && properties.WorkingDirectory === old.cwd &&
      entries.some(entry => properties.ExecStart?.includes(entry));
    const directlyManaged = Number(properties.MainPID) === old.pid && !!properties.ExecStart || wrapperManaged;
    const homeMatch = pm2Home && (properties.Environment?.includes(`PM2_HOME=${pm2Home} `) ||
      properties.Environment?.endsWith(`PM2_HOME=${pm2Home}`) || properties.Environment?.includes(`PM2_HOME="${pm2Home}"`));
    const pm2Resurrects = old.pm2 && persistedOldPm2 && homeMatch &&
      /(?:^|[\s/])pm2(?:\s|$)/u.test(properties.ExecStart || '') && /\bresurrect\b/u.test(properties.ExecStart || '');
    if ((directlyManaged || pm2Resurrects) && (activeRestart || bootEnabled)) {
      const command = `systemctl${user ? ' --user' : ''}`;
      const plan = { status: 'handoff-required', newAutostartConfigured: false, unit, scope: user ? 'user' : 'system',
        ...(pm2Home && { pm2Home }), reason: directlyManaged ? 'old-bot-service' : 'persisted-old-pm2',
        dedicated: !!directlyManaged, mainPid: Number(properties.MainPID), controlGroup: properties.ControlGroup,
        unitFileState: properties.UnitFileState,
        inspectCommand: `${command} show ${unit} -p ExecStart -p Restart -p UnitFileState`,
        message: `${text('boot_takeover')} ${unit}` };
      Object.defineProperty(plan, 'properties', { value: properties });
      return plan;
    }
  }
  return { status: 'not-configured', newAutostartConfigured: false, ...(pm2Home && { pm2Home }),
    persistedOldPm2, checkedUnits: units, ...(unverifiedUnits.length && { unverifiedUnits }) };
}

export async function prepareBootTakeover(plan, old, target, bun, work, options, io) {
  if (plan.status !== 'handoff-required') return;
  if (plan.reason === 'persisted-old-pm2') {
    const { preparePm2Takeover } = await import('./legacy-migrate-pm2.mjs');
    return preparePm2Takeover(plan, old, target, bun, work, options, io);
  }
  const { prepareSystemdTakeover } = await import('./legacy-migrate-systemd.mjs');
  return prepareSystemdTakeover(plan, old, target, bun, work, options, io);
}
