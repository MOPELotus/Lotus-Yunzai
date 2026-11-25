import { readFile, writeFile, mkdir, rename, rm, lstat, realpath, readlink, open } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { migrationEnvironment } from './legacy-migrate-environment.mjs';
import { prepareMigrationPm2, inspectLegacyBoot, prepareBootTakeover } from './legacy-migrate-background.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../i18n/legacy-migrate/zh-CN.json', import.meta.url), 'utf8')).messages;
const text = key => catalog[key] || key;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const within = (a, b) => { const p = relative(a, b); return !isAbsolute(p) && p !== '..' && !p.startsWith('../'); };
const exists = async p => !!await lstat(p).catch(e => { if (e.code !== 'ENOENT') throw e; });

export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw Error(text('identity'));
  try {
    const [stat, execPath, cwd, cmd] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'), readlink(`/proc/${pid}/exe`), readlink(`/proc/${pid}/cwd`), readFile(`/proc/${pid}/cmdline`),
    ]);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, startTimeTicks: fields[19], execPath, cwd, argv: cmd.toString().split('\0').filter(Boolean).slice(1), zombie: fields[0] === 'Z' };
  } catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') return null; throw e; }
}
function matching(actual, old) {
  return actual && !actual.zombie && actual.startTimeTicks === old.startTimeTicks &&
    actual.execPath === old.execPath && actual.cwd === old.cwd && JSON.stringify(actual.argv) === JSON.stringify(old.argv);
}

export function parsePm2ProcessList(output) {
  const textValue = output.trim();
  for (let start = textValue.lastIndexOf('['); start >= 0; start = textValue.lastIndexOf('[', start - 1)) {
    try {
      const value = JSON.parse(textValue.slice(start));
      if (Array.isArray(value) && value.every(row => row && typeof row === 'object' &&
          Number.isSafeInteger(row.pm_id) && Number.isSafeInteger(row.pid) && typeof row.pm2_env?.status === 'string')) return value;
    } catch {}
    if (start === 0) break;
  }
  throw Error(text('identity'));
}

export async function updateMigrationState(path, patch) {
  const lock = path + '.write-lock';
  let acquired = false;
  for (let i = 0; i < 200; i++) {
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; await sleep(25); }
  }
  if (!acquired) throw Error(text('timeout'));
  const temporary = path + '.' + randomUUID();
  try {
    const current = JSON.parse(await readFile(path, 'utf8'));
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await writeFile(temporary, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    return next;
  } finally { await rm(temporary, { force: true }); await rm(lock, { recursive: true }); }
}

async function validatePaths(source, target, statePath) {
  if (within(source, target) || within(target, source) || within(source, statePath) || within(target, statePath)) throw Error(text('unsafe'));
  for (const path of [source, target, dirname(statePath)]) {
    if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw Error(text('unsafe'));
  }
  const directory = await lstat(dirname(statePath)), state = await lstat(statePath);
  if (directory.mode & 0o077 || directory.uid !== process.getuid?.() || !state.isFile() || state.nlink !== 1 ||
      state.mode & 0o077 || state.uid !== process.getuid?.()) throw Error(text('unsafe'));
}

function execute(command, args, { cwd, env, log, signal }) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, env, signal, stdio: ['ignore', log, log] });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? done() : reject(Error(`${text('command')} (${code ?? signal})`)));
  });
}
async function capture(command, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let result = '';
    child.stdout.on('data', b => { if (result.length < 1024 * 1024) result += b; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? done(result.trim()) : reject(Error(text('command'))));
  });
}
export async function prepareBun(work, options, injected = {}) {
  const readCommand = injected.capture || capture, runCommand = injected.execute || execute;
  const version = '1.4.4';
  const candidates = injected.candidates || [join(work, 'bun/bin/bun'), join(root, 'data/tools/bin/bun'),
    ...(process.env.PATH || '').split(delimiter).filter(Boolean).map(path => resolve(path, 'bun'))];
  for (const executable of candidates) {
    try { if (await readCommand(executable, ['--version']) === version) return executable; } catch {}
  }
  const installer = join(work, 'install-bun.sh');
  const installerHome = join(work, 'install-home');
  await mkdir(join(installerHome, '.config'), { recursive: true, mode: 0o700 });
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const effective = await readCommand('curl', ['--fail', '--silent', '--show-error', '--location', '--max-redirs', '3',
        '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '15', '--max-time', '60',
        '--output', installer, '--write-out', '%{url_effective}', i % 2 === 0 ? 'https://bun.com/install' : 'https://bun.sh/install'], { env: options.env });
      const downloaded = new URL(effective);
      if (downloaded.protocol !== 'https:' || !['bun.com', 'bun.sh'].includes(downloaded.hostname)) throw Error(text('unsafe'));
      const script = await open(installer, 'r');
      try { await script.chmod(0o600); } finally { await script.close(); }
      await runCommand('bash', [installer, `bun-v${version}`], { ...options, env: { ...options.env,
        BUN_INSTALL: join(work, 'bun'), HOME: installerHome, XDG_CONFIG_HOME: join(installerHome, '.config'), SHELL: '/bin/sh' } });
      const executable = candidates[0];
      if (await readCommand(executable, ['--version']) !== version) throw Error(text('version'));
      return executable;
    } catch (e) { last = e; }
  }
  throw last;
}

export async function runLegacyMigration({ source, statePath, target = root, signal, resume = false }, injected = {}) {
  source = resolve(source); target = resolve(target); statePath = resolve(statePath);
  await validatePaths(source, target, statePath);
  const lock = statePath + '.worker-lock';
  async function verifyResume() {
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    const token = process.env.LOTUS_MIGRATION_RESUME_TOKEN;
    if (!token || saved.resumeToken !== token || saved.phase !== 'isolating-worker') throw Error(text('unsafe'));
  }
  if (resume) await verifyResume();
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (!resume || error.code !== 'EEXIST' || attempt >= 200) throw error;
      signal?.throwIfAborted(); await sleep(50);
    }
  }
  if (resume) {
    try { await verifyResume(); }
    catch (error) { await rm(lock, { recursive: true }); throw error; }
  }
  const logFile = await open(join(dirname(statePath), 'worker.log'), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  const io = { execute, capture, identity: processIdentity, kill: (pid, sig) => process.kill(pid, sig), sleep, prepareBun,
    preparePm2: prepareMigrationPm2, inspectBoot: inspectLegacyBoot, prepareBoot: prepareBootTakeover, parsePm2ProcessList,
    isolateWorker: async (...args) => {
      const { isolateMigrationWorker } = await import('./legacy-migrate-systemd.mjs');
      return isolateMigrationWorker(...args);
    },
    restore: async old => {
      const child = spawn(old.execPath, old.restoreArgv || old.argv, { cwd: old.cwd, env: old.env || process.env, detached: true,
        stdio: ['ignore', logFile.fd, logFile.fd] });
      await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
      child.unref(); return child.pid;
    }, ...injected };
  let phase = 'preparing', stopped = false, startupAttempted = false, old, bun, result, takeover, storagePlan, storageStarted = false, storageQuiesced = false, storagePauseExpiresAt;
  const originalEnvironment = { ...process.env };
  delete originalEnvironment.LOTUS_MIGRATION_RESUME_TOKEN;
  const environment = migrationEnvironment(originalEnvironment);
  const options = { cwd: target, env: environment, log: logFile.fd, signal };
  const recoveryOptions = { ...options, signal: undefined };
  const oldOptions = { cwd: source, env: originalEnvironment, log: logFile.fd };
  const storageCommand = async (action, value, recovering = false, captured = false) => {
    const helper = join(target, 'scripts/legacy-migrate-valkey.ts');
    return io[captured ? 'capture' : 'execute'](bun, [helper, action, value], recovering ? recoveryOptions : options);
  };
  const state = async patch => { result = await updateMigrationState(statePath, { ...patch, workerPid: process.pid }); return result; };
  const stage = async (value, key) => { signal?.throwIfAborted(); phase = value; await state({ phase, message: text(key) }); };
  async function alive() { const current = await io.identity(old.pid); return matching(current, old); }
  async function waitGone() {
    for (let i = 0; i < 300; i++) { if (!await alive()) return; await io.sleep(100); }
    throw Error(text('timeout'));
  }
  try {
    signal?.throwIfAborted();
    result = JSON.parse(await readFile(statePath, 'utf8'));
    if (result.phase && !['created', 'cloned'].includes(result.phase) && !(resume && result.phase === 'isolating-worker')) throw Error(text('unsafe'));
    old = result.oldHost;
    if (!old || !Array.isArray(old.argv) || old.argv.some(x => typeof x !== 'string')) throw Error(text('identity'));
    if (old.cwd !== source) throw Error(text('identity'));
    if (old.restoreArgv !== undefined && (!Array.isArray(old.restoreArgv) || !old.restoreArgv.length ||
        old.restoreArgv.some(value => typeof value !== 'string'))) throw Error(text('identity'));
    const actual = await io.identity(old.pid);
    if (!actual || actual.zombie || actual.execPath !== old.execPath || actual.cwd !== old.cwd ||
        JSON.stringify(actual.argv) !== JSON.stringify(old.argv) || old.startTimeTicks && actual.startTimeTicks !== old.startTimeTicks) throw Error(text('identity'));
    if (old.env !== undefined && (!old.env || typeof old.env !== 'object' || Array.isArray(old.env) ||
        Object.values(old.env).some(value => typeof value !== 'string'))) throw Error(text('identity'));
    old = { ...old, startTimeTicks: actual.startTimeTicks };
    oldOptions.env = old.env || originalEnvironment;
    for (const name of ['config', 'data', 'backup']) if (await exists(join(target, name))) throw Error(text('unsafe'));
    if (old.pm2 && (!Number.isSafeInteger(Number(old.pm2.id)) || Number(old.pm2.id) < 0 || typeof old.pm2.cli !== 'string')) throw Error(text('identity'));
    await state({ phase, oldHost: old, workerPid: process.pid, target, log: join(dirname(statePath), 'worker.log'), handoffApproved: false,
      ...(resume && { resumeToken: undefined }) });
    bun = await io.prepareBun(dirname(statePath), options);
    options.env.PATH = dirname(bun) + delimiter + (options.env.PATH || '');
    async function retry(command, args) {
      let last;
      for (let attempt = 1; attempt <= 3; attempt++) {
        signal?.throwIfAborted();
        try { await io.execute(command, args, options); return; } catch (error) { last = error; }
      }
      throw last;
    }
    await retry('git', ['submodule', 'update', '--init', '--recursive']);
    await stage('installing', 'preparing');
    await retry(bun, ['install']);
    options.env.PATH = join(target, 'node_modules/.bin') + delimiter + options.env.PATH;
    await stage('preparing-background', 'background');
    const background = await io.preparePm2(target, bun, dirname(statePath), options, io);
    await state({ background });
    await stage('checking-boot', 'boot_check');
    const boot = await io.inspectBoot(old, { ...oldOptions, signal }, io);
    await state({ boot });
    if (boot.status === 'handoff-required' && boot.reason === 'old-bot-service') {
      const token = randomUUID();
      await state({ phase: 'isolating-worker', resumeToken: token });
      const isolation = await io.isolateWorker(boot, old, target, dirname(statePath), { ...options, statePath }, io, token);
      if (isolation.isolated) return await state({ isolation, phase: 'isolating-worker', message: text('worker_isolating') });
      await state({ phase, resumeToken: undefined });
    }
    takeover = await io.prepareBoot(boot, old, target, bun, dirname(statePath), options, io);
    if (takeover) await state({ boot: takeover.report() });
    if (boot.status === 'blocked') throw Error(boot.message);
    const storageHelper = join(target, 'scripts/legacy-migrate-valkey.ts');
    if (await exists(storageHelper)) {
      await stage('preparing-storage', 'storage_preparing');
      const prepared = JSON.parse(await io.capture(bun, [storageHelper, 'prepare', source, target, String(old.pid), dirname(statePath),
        ...(boot.reason === 'old-bot-service' && boot.dedicated === true && typeof boot.controlGroup === 'string' && boot.controlGroup.split('/').includes(boot.unit) ? [boot.controlGroup] : [])], options));
      if (!['prepared', 'none', 'external'].includes(prepared?.status) || prepared.status === 'prepared' && typeof prepared.plan !== 'string') throw Error(text('storage_failed'));
      if (prepared.status === 'prepared') {
        storagePlan = prepared.plan;
        if (!isAbsolute(storagePlan) || !within(dirname(statePath), storagePlan)) throw Error(text('storage_failed'));
      }
      await state({ storage: prepared });
    }
    await stage('ready-to-stop', 'ready');
    let approved = false;
    for (let i = 0; i < 3600; i++) {
      signal?.throwIfAborted();
      const current = JSON.parse(await readFile(statePath, 'utf8'));
      if (current.handoffApproved === true) { approved = true; break; }
      if (!await alive()) throw Error(text('identity'));
      await io.sleep(500);
    }
    if (!approved) throw Error(text('timeout'));
    if (!await alive()) throw Error(text('identity'));
    if (old.pm2) {
      const entries = parsePm2ProcessList(await io.capture(old.pm2.cli, ['jlist'], { cwd: source, env: oldOptions.env }));
      const registered = entries.find(entry => String(entry.pm_id) === String(old.pm2.id));
      if (registered?.pid !== old.pid || registered.pm2_env?.status !== 'online') throw Error(text('identity'));
    }
    if (storagePlan) {
      await stage('quiescing-storage', 'storage_quiescing');
      storageQuiesced = true;
      const frozen = JSON.parse(await storageCommand('quiesce', storagePlan, false, true));
      if (frozen.pauseExpiresAt !== undefined && (!Number.isFinite(frozen.pauseExpiresAt) || frozen.pauseExpiresAt <= 0)) throw Error(text('storage_failed'));
      storagePauseExpiresAt = frozen.pauseExpiresAt;
    }
    await stage('stopping-old', 'stopping');
    stopped = true;
    if (takeover) await takeover.stopOld();
    else if (old.pm2) await io.execute(old.pm2.cli, ['stop', String(old.pm2.id)], { ...oldOptions, signal });
    else io.kill(old.pid, 'SIGTERM');
    await waitGone();
    if (storagePauseExpiresAt !== undefined && Date.now() >= storagePauseExpiresAt) throw Error(text('storage_failed'));
    await stage('migrating', 'migrating');
    await io.execute(bun, ['run', 'migrate', source], options);
    if (storagePlan) {
      await stage('publishing-storage', 'storage_publishing');
      await storageCommand('publish', storagePlan);
      storageStarted = true;
      await storageCommand('start', target);
    }
    await stage('initializing', 'initializing');
    await io.execute(bun, ['run', 'bootstrap'], options);
    if (storageStarted) { await storageCommand('stop', target); storageStarted = false; }
    await stage('starting-new', 'starting');
    startupAttempted = true;
    if (takeover) {
      await takeover.startNew();
      await state({ boot: takeover.report() });
    } else await io.execute(bun, ['run', 'start:bg'], options);
    if (storagePlan) await state({ storage: { status: 'completed', plan: storagePlan } });
    await stage('completed', 'completed');
    return result;
  } catch (error) {
    const failedStage = phase;
    let recovery = stopped ? 'pending' : 'old-untouched';
    if (!stopped && storageQuiesced) {
      try { await storageCommand('resume', storagePlan, true); }
      catch { recovery = 'failed'; }
    }
    if (stopped) {
      try {
        if (startupAttempted) {
          if (takeover) await takeover.stopNew();
          else await io.execute(bun, ['run', 'stop'], recoveryOptions);
        }
        if (storagePlan) { await storageCommand('stop', target, true); storageStarted = false; }
        if (storageQuiesced) await storageCommand('resume', storagePlan, true);
        if (takeover) {
          await takeover.rollback();
          recovery = 'old-restored';
          await state({ boot: takeover.report() });
        } else {
        if (await alive()) recovery = 'old-still-running';
        else if (old.pm2) {
          await io.execute(old.pm2.cli, ['restart', String(old.pm2.id)], oldOptions);
          const rows = parsePm2ProcessList(await io.capture(old.pm2.cli, ['jlist'], { cwd: old.cwd, env: oldOptions.env }));
          const record = rows.find(row => String(row.pm_id) === String(old.pm2.id));
          if (record?.pm2_env?.status !== 'online' || !await io.identity(record.pid)) throw Error(text('recovery'));
          recovery = 'old-restored';
        } else {
          const pid = await io.restore(old);
          await io.sleep(1000);
          const restored = await io.identity(pid);
          if (!restored || restored.zombie || restored.execPath !== old.execPath || restored.cwd !== old.cwd ||
              !([old.argv, old.restoreArgv].filter(Boolean).some(argv => JSON.stringify(restored.argv) === JSON.stringify(argv)))) throw Error(text('recovery'));
          recovery = 'old-restored';
        }
        }
      } catch { recovery = 'failed'; }
    }
    await state({ phase: 'failed', failedStage, message: text('failed'), recovery, error: error.message });
    throw error;
  } finally { await logFile.close(); await rm(lock, { recursive: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
  const controller = new AbortController();
  const abort = () => controller.abort(Error(text('failed')));
  process.on('SIGTERM', abort); process.on('SIGINT', abort);
  try {
    if (!args.includes('--source') || !args.includes('--state')) throw Error(text('unsafe'));
    const source = resolve(value('--source')), statePath = resolve(value('--state'));
    if (args.includes('--approve')) {
      await validatePaths(source, root, statePath);
      const current = JSON.parse(await readFile(statePath, 'utf8'));
      if (current.phase !== 'ready-to-stop') throw Error(text('unsafe'));
      await updateMigrationState(statePath, { handoffApproved: true });
    } else await runLegacyMigration({ source, statePath, signal: controller.signal, resume: args.includes('--resume') });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { process.off('SIGTERM', abort); process.off('SIGINT', abort); }
}
