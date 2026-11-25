import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { migrationEnvironment } from './legacy-migrate-environment.mjs';

const catalog = JSON.parse(await readFile(new URL('../i18n/legacy-migrate/zh-CN.json', import.meta.url), 'utf8')).messages;
function failure(key) { return Object.assign(Error(catalog[key] || key), { code: key }); }
const parseShow = value => Object.fromEntries(String(value).split(/\r?\n/u).flatMap(line => {
  const at = line.indexOf('='); return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : [];
}));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const unitPattern = /^[A-Za-z0-9_.@:\\-]+\.service$/u;
const metadata = /^(?:PWD|OLDPWD|INVOCATION_ID|JOURNAL_STREAM|NOTIFY_SOCKET|LISTEN_PID|LISTEN_FDS|LISTEN_FDNAMES|WATCHDOG_PID|WATCHDOG_USEC|MAINPID|MANAGERPID|RUNTIME_DIRECTORY|STATE_DIRECTORY|CACHE_DIRECTORY|LOGS_DIRECTORY|CONFIGURATION_DIRECTORY|CREDENTIALS_DIRECTORY)$/u;
function quoted(value, exec = false) {
  if (typeof value !== 'string' || /[\0\r\n]/u.test(value)) throw failure('systemd_environment');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', exec ? '$$' : '$') + '"';
}
async function present(path) { return lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
async function privateFile(path, contents) { await writeFile(path, contents, { mode: 0o600, flag: 'wx' }); }
async function safeDirectory(path) {
  const physical = await realpath(path);
  if (physical !== resolve(path) || !(await lstat(path)).isDirectory()) throw failure('systemd_snapshot');
}
function environment(old, options, target, bun, readyFile, manager) {
  const original = { ...(old.env || options.env) };
  const clean = migrationEnvironment(original);
  for (const [key, value] of Object.entries(clean)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== 'string' || metadata.test(key) ||
        value.includes(old.cwd) || /[\0\r\n]/u.test(value)) delete clean[key];
  }
  clean.PATH = [dirname(bun), ...(clean.PATH || '/usr/bin:/bin').split(':').filter(path => isAbsolute(path) && !path.includes(old.cwd))].join(':');
  clean.LOTUS_SERVICE_READY_FILE = readyFile;
  const excluded = [...new Set([...Object.keys(original), ...Object.keys(parseShow(manager))])]
    .filter(key => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && !Object.hasOwn(clean, key)).sort();
  const contents = Object.entries(clean).map(([key, value]) => `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join('\n') + '\n';
  return { contents, excluded };
}

async function userManagerEnvironment(env, uid, io) {
  if (io.userManagerEnvironment) return io.userManagerEnvironment(env, uid);
  const runtime = `/run/user/${uid}`, bus = join(runtime, 'bus');
  const directory = await lstat(runtime).catch(() => undefined), socket = await lstat(bus).catch(() => undefined);
  if (!directory?.isDirectory() || directory.uid !== uid || directory.mode & 0o077 ||
      await realpath(runtime) !== runtime || !socket?.isSocket() || socket.uid !== uid) throw failure('systemd_permissions');
  return { ...env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` };
}

/** setsid/detached does not leave the old unit's control group. */
export async function assertWorkerDetachedFromOldUnit(plan, io = {}) {
  const group = typeof plan === 'string' ? plan : plan?.controlGroup || plan?.properties?.ControlGroup;
  if (!group || group === '/' || !group.startsWith('/')) throw failure('systemd_identity');
  const contents = await (io.readWorkerCgroup ? io.readWorkerCgroup() : readFile('/proc/self/cgroup', 'utf8'));
  if (String(contents).split('\n').some(line => {
    const path = line.split(':').slice(2).join(':');
    return path === group || path.startsWith(group + '/');
  })) throw Object.assign(failure('systemd_preflight'), { requiresDetachedWorker: true });
  return true;
}

/** Prepare without stopping anything. Only a dedicated, identity-checked bot unit is eligible. */
export async function prepareSystemdTakeover(plan, old, target, bun, work, options, io) {
  options.signal?.throwIfAborted();
  if (!plan || !unitPattern.test(plan.unit || '') || plan.unit.startsWith('-') || !['user', 'system'].includes(plan.scope) ||
      plan.reason !== 'old-bot-service' || old.pm2 || !Number.isSafeInteger(old.pid) || old.pid <= 1) throw failure('systemd_identity');
  target = await realpath(target); work = await realpath(work);
  if (!isAbsolute(bun) || !isAbsolute(old.cwd) || target === old.cwd) throw failure('systemd_identity');
  const user = plan.scope === 'user';
  const systemctl = io.systemctlPath || '/usr/bin/systemctl';
  const install = io.installPath || '/usr/bin/install';
  const remove = io.removePath || '/usr/bin/rm';
  const uid = io.getuid ? io.getuid() : process.getuid?.();
  const privileged = !user && uid !== 0;
  const managerEnvironment = user ? await userManagerEnvironment(options.env, uid, io) : options.env;
  const flags = [...(user ? ['--user'] : []), '--no-ask-password', '--no-pager'];
  const timeout = (recovery = false) => ({ ...options, ...(recovery && { signal: undefined }),
    env: { ...managerEnvironment, SYSTEMD_PAGER: 'cat', SYSTEMD_PAGERSECURE: '1', SYSTEMD_COLORS: '0' },
    signal: recovery || !options.signal ? AbortSignal.timeout(15_000) : AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) });
  const execute = (command, args, recovery = false) => privileged
    ? io.execute('/usr/bin/sudo', ['-n', '--', command, ...args], timeout(recovery)) : io.execute(command, args, timeout(recovery));
  const capture = (args, recovery = false) => io.capture(systemctl, [...flags, ...args], timeout(recovery));
  const action = (verb, recovery = false) => execute(systemctl, [...flags, verb, ...(verb === 'daemon-reload' ? [] : [plan.unit])], recovery);
  const properties = (recovery = false) => capture(['show', plan.unit, '--property=MainPID,ActiveState,SubState,LoadState,UnitFileState,FragmentPath,DropInPaths,WorkingDirectory,ExecStart,ControlGroup,User,DynamicUser'], recovery);
  const initial = parseShow(await properties());
  const actual = await io.identity(old.pid);
  if (!actual || actual.cwd !== old.cwd || old.startTimeTicks && actual.startTimeTicks !== old.startTimeTicks ||
      JSON.stringify(actual.argv) !== JSON.stringify(old.argv) || initial.LoadState !== 'loaded' || initial.ActiveState !== 'active') throw failure('systemd_identity');
  await assertWorkerDetachedFromOldUnit(initial.ControlGroup, io);
  const credentials = user ? { uid, gid: io.getgid ? io.getgid() : process.getgid?.() } : await (io.processCredentials ? io.processCredentials(old.pid) : lstat(`/proc/${old.pid}`));
  if (!Number.isInteger(credentials.uid) || credentials.uid < 0 || !user && (!Number.isInteger(credentials.gid) || credentials.gid < 0 || initial.DynamicUser === 'yes')) throw failure('systemd_identity');
  const oldMainPID = Number(initial.MainPID);
  if (oldMainPID !== old.pid) {
    const cgroup = await (io.readProcessCgroup ? io.readProcessCgroup(old.pid) : readFile(`/proc/${old.pid}/cgroup`, 'utf8'));
    const entry = old.argv?.find(value => isAbsolute(value) && value.startsWith(old.cwd + '/'));
    if (plan.dedicated !== true || Number(plan.mainPid) !== oldMainPID || oldMainPID <= 1 || initial.WorkingDirectory !== old.cwd ||
        !entry || !initial.ExecStart?.includes(entry) || !initial.ControlGroup ||
        !String(cgroup).split('\n').some(line => line.split(':').slice(2).join(':') === initial.ControlGroup)) throw failure('systemd_identity');
  }
  const parent = io.systemdDirectory || (user ? join(options.env.XDG_CONFIG_HOME || join(options.env.HOME || '', '.config'), 'systemd/user') : '/etc/systemd/system');
  if (!isAbsolute(parent)) throw failure('systemd_permissions');
  const dropInDirectory = join(parent, plan.unit + '.d');
  const dropInExisted = !!await present(dropInDirectory);
  const originalPaths = [initial.FragmentPath, ...(initial.DropInPaths || '').split(/\s+/u).filter(Boolean).map(path => path.replace(/\\x([0-9a-f]{2})/giu, (_, hex) => String.fromCharCode(parseInt(hex, 16))))];
  if (!originalPaths[0] || originalPaths.some(path => !isAbsolute(path))) throw failure('systemd_snapshot');
  const backup = join(work, 'systemd-' + randomUUID());
  await mkdir(backup, { mode: 0o700 });
  await chmod(backup, 0o700);
  const snapshots = [];
  for (const [index, path] of originalPaths.entries()) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o002) throw failure('systemd_snapshot');
    const bytes = await readFile(path);
    await privateFile(join(backup, `${index}.unit`), bytes);
    snapshots.push({ path, sha256: digest(bytes), mode: stat.mode & 0o777 });
  }
  const name = [ 'zz-lotus-takeover', ...originalPaths.slice(1).map(path => basename(path)) ].sort().at(-1) + '.' + randomUUID() + '.conf';
  if (Buffer.byteLength(name) > 255) throw failure('systemd_conflict');
  const dropInPath = join(dropInDirectory, name);
  const readyDirectory = join(target, 'data/boot-handoff');
  const readyFile = join(readyDirectory, 'service-ready.json');
  const envFile = join(readyDirectory, 'systemd-environment-' + randomUUID());
  const mappingPath = join(readyDirectory, 'service.json');
  const mappingBytes = JSON.stringify({ format: 1, root: target, unit: plan.unit, scope: plan.scope, uid: credentials.uid });
  let ancestor = readyDirectory;
  while (!await present(ancestor)) ancestor = dirname(ancestor);
  await safeDirectory(ancestor);
  if (!privileged) await access(ancestor, constants.W_OK);
  if (await present(readyFile) || await present(dropInPath) || await present(mappingPath)) throw failure('systemd_conflict');
  const manager = await capture(['show-environment']);
  const preparedEnvironment = environment(old, options, target, bun, readyFile, manager);
  const envSource = join(backup, 'environment');
  await privateFile(envSource, preparedEnvironment.contents);
  const mappingSource = join(backup, 'service.json');
  await privateFile(mappingSource, mappingBytes);
  const overrideSource = join(backup, 'takeover.conf');
  const override = ['[Service]', ...(!user ? [`User=${credentials.uid}`, `Group=${credentials.gid}`, 'DynamicUser=no'] : []), 'Type=simple', 'PIDFile=', 'GuessMainPID=no', 'RemainAfterExit=no', 'NotifyAccess=none', 'WatchdogSec=0',
    'ExecStart=', 'ExecStartPre=', 'ExecStartPost=', 'ExecCondition=', 'ExecStop=', 'ExecStopPost=', 'ExecReload=',
    'Environment=', 'EnvironmentFile=', 'PassEnvironment=', 'UnsetEnvironment=',
    ...(preparedEnvironment.excluded.length ? ['UnsetEnvironment=' + preparedEnvironment.excluded.join(' ')] : []),
    'RootDirectory=', 'RootImage=', `WorkingDirectory=${target.replaceAll("%", "%%")}`,
    `EnvironmentFile=${envFile.replaceAll("%", "%%")}`, `ExecStart=${quoted(bun, true)} --no-env-file ${quoted(join(target, 'scripts/launcher.ts'), true)} start`,
    'KillMode=control-group', 'Restart=on-failure', 'RestartSec=2', 'TimeoutStartSec=180', 'StandardInput=null', 'StandardOutput=journal', 'StandardError=journal', ''].join('\n');
  await privateFile(overrideSource, override);
  await privateFile(join(backup, 'manifest.json'), JSON.stringify({ format: 1, unit: plan.unit, scope: plan.scope, oldMainPID,
    enabledState: initial.UnitFileState, snapshots, dropInPath, envFile, readyFile }));
  const createDirectory = [install, ['-d', '-m', '0755', '--', dropInDirectory]];
  const installOverride = [install, ['-m', '0644', '--', overrideSource, dropInPath]];
  const ownerArgs = !user ? ['-o', String(credentials.uid), '-g', String(credentials.gid)] : [];
  const createReadyDirectory = [install, ['-d', '-m', '0700', ...ownerArgs, '--', readyDirectory]];
  const installEnvironment = [install, ['-m', '0600', ...ownerArgs, '--', envSource, envFile]];
  const installMapping = [install, ['-m', '0600', ...ownerArgs, '--', mappingSource, mappingPath]];
  const removeOverride = [remove, ['-f', '--', dropInPath]];
  if (privileged) {
    for (const [command, args] of [...(dropInExisted ? [] : [createDirectory]), createReadyDirectory, installOverride, installEnvironment, installMapping, removeOverride,
      ...['stop', 'start', 'reset-failed', 'daemon-reload'].map(verb => [systemctl, [...flags, verb, ...(verb === 'daemon-reload' ? [] : [plan.unit])]])]) {
      try { await io.capture('/usr/bin/sudo', ['-n', '-l', '--', command, ...args], timeout()); }
      catch { throw failure('systemd_permissions'); }
    }
  } else {
    let writable = parent;
    while (!await present(writable)) writable = dirname(writable);
    await safeDirectory(writable); await access(writable, constants.W_OK);
    if (await present(dropInDirectory)) { await safeDirectory(dropInDirectory); await access(dropInDirectory, constants.W_OK); }
  }
  let mappingIdentity;
  let status = 'prepared', stopAttempted = false, startAttempted = false, installed = false, newMainPID;
  const snapshotMatches = async (recovery = false) => {
    const current = parseShow(await properties(recovery));
    if (current.FragmentPath !== initial.FragmentPath || current.UnitFileState !== initial.UnitFileState ||
        (current.DropInPaths || '').split(/\s+/u).filter(path => path && path !== dropInPath).join(' ') !== (initial.DropInPaths || '')) throw failure('systemd_conflict');
    for (const saved of snapshots) {
      const stat = await lstat(saved.path);
      if (!stat.isFile() || digest(await readFile(saved.path)) !== saved.sha256) throw failure('systemd_conflict');
    }
  };
  const report = () => ({ provider: 'systemd', unit: plan.unit, scope: plan.scope, status, backupDirectory: backup,
    dropInPath, readyFile, mappingPath, enabledState: initial.UnitFileState, oldMainPID, ...(newMainPID && { newMainPID }), newAutostartConfigured: status === 'active' && /^(?:enabled|enabled-runtime|generated)$/u.test(initial.UnitFileState) });
  async function waitStopped(recovery = false) {
    for (let attempt = 0; attempt < 150; attempt++) {
      const current = parseShow(await capture(['show', plan.unit, '--property=MainPID,ActiveState'], recovery));
      if (Number(current.MainPID) === 0 && ['inactive', 'failed'].includes(current.ActiveState)) return;
      await io.sleep(100);
    }
    throw failure('systemd_start');
  }
  return {
    report,
    async stopOld() {
      if (status !== 'prepared') throw failure('systemd_identity');
      options.signal?.throwIfAborted(); await assertWorkerDetachedFromOldUnit(initial.ControlGroup, io); await snapshotMatches();
      const current = parseShow(await properties());
      const identity = await io.identity(old.pid);
      if (Number(current.MainPID) !== oldMainPID || !identity || identity.cwd !== old.cwd ||
          old.startTimeTicks && identity.startTimeTicks !== old.startTimeTicks) throw failure('systemd_identity');
      stopAttempted = true; await action('stop'); await waitStopped(); status = 'stopped';
    },
    async startNew() {
      if (status !== 'stopped') throw failure('systemd_identity');
      options.signal?.throwIfAborted(); await snapshotMatches();
      if (await present(dropInPath) || await present(readyFile) || await present(mappingPath)) throw failure('systemd_conflict');
      await execute(...createReadyDirectory); await safeDirectory(readyDirectory);
      if (!dropInExisted) await execute(...createDirectory);
      await execute(...installEnvironment); await execute(...installOverride); installed = true;
      await execute(...installMapping); mappingIdentity = await lstat(mappingPath);
      await action('daemon-reload'); startAttempted = true; await action('start');
      const until = Date.now() + (options.systemdReadyTimeoutMs || 120_000);
      while (Date.now() < until) {
        options.signal?.throwIfAborted();
        const current = parseShow(await properties());
        if (current.ActiveState === 'failed' || current.ActiveState === 'inactive' || current.SubState === 'auto-restart') throw failure('systemd_start');
        const pid = Number(current.MainPID);
        if (Number.isSafeInteger(pid) && pid > 1 && current.ActiveState === 'active') {
          const identity = await io.identity(pid);
          const stat = await present(readyFile);
          if (identity?.cwd === target && stat?.isFile() && stat.uid === credentials.uid && stat.size < 4096 && !(stat.mode & 0o077)) {
            const ready = JSON.parse(await readFile(readyFile, 'utf8'));
            if (ready.pid === pid && ready.root === target) { newMainPID = pid; status = 'active'; return report(); }
          }
        }
        await io.sleep(100);
      }
      throw failure('systemd_ready');
    },
    async stopNew() {
      if (!startAttempted) return report();
      await action('stop', true); await waitStopped(true);
      startAttempted = false; status = 'new-stopped'; return report();
    },
    async rollback() {
      if (!stopAttempted || status === 'rolled-back') return report();
      if (startAttempted) { await action('stop', true); await waitStopped(true); startAttempted = false; }
      const mapping = await present(mappingPath);
      if (mappingIdentity && mapping?.isFile() && mapping.ino === mappingIdentity.ino && mapping.dev === mappingIdentity.dev &&
          await readFile(mappingPath, 'utf8') === mappingBytes) await rm(mappingPath);
      if (installed || await present(dropInPath)) await execute(...removeOverride, true);
      await rm(envFile, { force: true }); await rm(readyFile, { force: true });
      await snapshotMatches(true); await action('daemon-reload', true); await action('reset-failed', true); await action('start', true);
      let recovered = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        const restored = parseShow(await capture(['show', plan.unit, '--property=MainPID,ActiveState'], true));
        const identity = Number(restored.MainPID) > 1 ? await io.identity(Number(restored.MainPID)) : undefined;
        if (restored.ActiveState === 'active' && identity?.cwd === old.cwd) { recovered = true; break; }
        if (restored.ActiveState === 'failed') break;
        await io.sleep(100);
      }
      if (!recovered) throw failure('systemd_rollback');
      status = 'rolled-back'; return report();
    },
  };
}

/** Launch the continuation outside the old unit before it is allowed to stop that unit. */
export async function isolateMigrationWorker(plan, old, target, work, options, io, resumeToken) {
  const group = plan?.controlGroup || plan?.properties?.ControlGroup;
  if (!plan || !unitPattern.test(plan.unit || '') || plan.unit.startsWith('-') || plan.reason !== 'old-bot-service' ||
      !['user', 'system'].includes(plan.scope) || !group || group === '/') throw failure('systemd_identity');
  try { await assertWorkerDetachedFromOldUnit(group, io); return { isolated: false, reason: 'already-isolated' }; }
  catch (error) { if (error.requiresDetachedWorker !== true) throw error; }
  if (typeof resumeToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/u.test(resumeToken)) throw failure('systemd_preflight');
  target = await realpath(target); work = await realpath(work);
  const command = options.isolationCommand || (options.statePath && [process.execPath, join(target, 'scripts/legacy-migrate.mjs'), '--source', old.cwd, '--state', options.statePath, '--resume']);
  if (!Array.isArray(command) || command.length < 2 || command.some(value => typeof value !== 'string' || /[\0\r\n]/u.test(value)) ||
      !isAbsolute(command[0]) || !command[1].startsWith(target + '/')) throw failure('systemd_preflight');
  const unit = 'lotus-migration-worker-' + randomUUID() + '.service';
  const uid = io.getuid ? io.getuid() : process.getuid?.();
  let user = plan.scope === 'user', managerEnvironment = options.env;
  if (user) managerEnvironment = await userManagerEnvironment(options.env, uid, io);
  else if (uid !== 0) {
    try { managerEnvironment = await userManagerEnvironment(options.env, uid, io); user = true; }
    catch { /* A system-scope continuation still requires exact noninteractive authorization. */ }
  }
  const privileged = !user && uid !== 0;
  const prefix = [...(user ? ['--user'] : []), '--no-ask-password'];
  const systemctl = io.systemctlPath || '/usr/bin/systemctl';
  const systemdRun = io.systemdRunPath || '/usr/bin/systemd-run';
  const recovery = () => ({ ...options, env: managerEnvironment, signal: AbortSignal.timeout(15_000) });
  const active = () => ({ ...options, env: managerEnvironment, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  const envFile = join(work, '.isolated-worker-' + randomUUID() + '.env');
  const log = join(work, 'worker.log');
  const prepared = environment(old, options, target, command[0], '', '');
  await privateFile(envFile, prepared.contents.replace(/^LOTUS_SERVICE_READY_FILE=.*\n/mu, '').replace(user ? /^(?:XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=.*\n/gmu : /$^/u, '') +
    (user ? `XDG_RUNTIME_DIR="${managerEnvironment.XDG_RUNTIME_DIR}"\nDBUS_SESSION_BUS_ADDRESS="${managerEnvironment.DBUS_SESSION_BUS_ADDRESS}"\n` : '') + `LOTUS_MIGRATION_RESUME_TOKEN="${resumeToken}"\n`);
  const properties = ['Type=exec', 'KillMode=process', 'TimeoutStopSec=15',
    `WorkingDirectory=${target.replaceAll('%', '%%')}`, `EnvironmentFile=${envFile.replaceAll('%', '%%')}`,
    `StandardOutput=append:${log.replaceAll('%', '%%')}`, `StandardError=append:${log.replaceAll('%', '%%')}`,
    ...(!user ? [`User=${uid}`, `Group=${process.getgid()}`] : [])];
  const args = [...prefix, '--unit=' + unit, '--collect', ...properties.map(value => '--property=' + value), '--', ...command];
  const stopArgs = [...prefix, '--no-pager', 'stop', unit];
  const execute = (binary, argv, opts) => privileged ? io.execute('/usr/bin/sudo', ['-n', '--', binary, ...argv], opts) : io.execute(binary, argv, opts);
  const capture = args => io.capture(systemctl, [...prefix, '--no-pager', ...args], active());
  let attempted = false;
  try {
    if (privileged) {
      for (const [binary, argv] of [[systemdRun, args], [systemctl, stopArgs]]) {
        try { await io.capture('/usr/bin/sudo', ['-n', '-l', '--', binary, ...argv], active()); }
        catch { throw failure('systemd_permissions'); }
      }
    }
    options.signal?.throwIfAborted(); attempted = true;
    await execute(systemdRun, args, active());
    const executable = await realpath(command[0]);
    for (let attempt = 0; attempt < 100; attempt++) {
      options.signal?.throwIfAborted();
      const observed = parseShow(await capture(['show', unit, '--property=MainPID,ActiveState,SubState,ControlGroup']));
      if (observed.ActiveState === 'failed' || observed.ActiveState === 'inactive') throw failure('systemd_preflight');
      const pid = Number(observed.MainPID);
      if (Number.isInteger(pid) && pid > 1 && observed.ActiveState === 'active' && observed.ControlGroup &&
          observed.ControlGroup !== group && !observed.ControlGroup.startsWith(group + '/')) {
        const identity = await io.identity(pid);
        const membership = await (io.readProcessCgroup ? io.readProcessCgroup(pid) : readFile(`/proc/${pid}/cgroup`, 'utf8'));
        if (identity?.cwd === target && identity.execPath === executable && JSON.stringify(identity.argv) === JSON.stringify(command.slice(1)) &&
            String(membership).split('\n').some(line => line.split(':').slice(2).join(':') === observed.ControlGroup)) {
          return { isolated: true, unit, scope: user ? 'user' : 'system', pid, controlGroup: observed.ControlGroup, environmentFile: envFile, logFile: log };
        }
      }
      await io.sleep(100);
    }
    throw failure('systemd_preflight');
  } catch (error) {
    if (attempted) await execute(systemctl, stopArgs, recovery()).catch(() => undefined);
    await rm(envFile, { force: true });
    throw error;
  }
}
