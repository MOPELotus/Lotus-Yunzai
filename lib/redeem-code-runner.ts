import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { lockFile } from "./file-lock.ts";

const redeemGames = {
  gs: { name: "原神", count: 3, regions: ["cn_gf01", "cn_qd01"] },
  sr: { name: "星穹铁道", count: 3, regions: ["prod_gf_cn", "prod_qd_cn"] },
  zzz: { name: "绝区零", count: 1, regions: ["prod_gf_cn", "prod_qd_cn"] },
} as const;

export type PreviewGame = keyof typeof redeemGames;
export interface PreviewProfile {
  readonly qq: string;
  readonly profileId: number;
  readonly games: readonly PreviewGame[];
  readonly allowNewJournal?: boolean;
}
export interface PreviewRole {
  readonly uid: string;
  readonly region: string;
}

const resultText = {
  succeeded: "使用成功",
  "already-used": "已使用",
  expired: "兑换码已过期",
  invalid: "兑换码无效",
  blocked: "请求已被拒绝，请在官方客户端检查账号状态",
  unknown: "结果未确认，请到游戏内检查",
} as const;
export type PreviewSubmissionStatus = keyof typeof resultText;
export interface PreviewRoleAccess {
  readonly accountId: string;
  readonly roles: readonly PreviewRole[];
  readonly selectedUid: string;
  readonly submit: (code: string, role: PreviewRole, signal?: AbortSignal) => Promise<{ status: PreviewSubmissionStatus }>;
  readonly notify?: (reply: string, signal?: AbortSignal) => Promise<unknown>;
}

interface Options {
  readonly journal: string;
  readonly legacyJournal?: string | readonly string[];
  readonly lookup: (game: PreviewGame, signal?: AbortSignal) => Promise<unknown>;
  readonly listProfiles: (signal?: AbortSignal) => Promise<readonly PreviewProfile[]>;
  readonly readRoles: (profile: PreviewProfile, game: PreviewGame, signal?: AbortSignal) => Promise<PreviewRoleAccess | undefined>;
  readonly notify?: (profile: PreviewProfile, reply: string, signal?: AbortSignal) => Promise<unknown>;
  readonly now?: () => number;
  readonly requireExistingJournal?: boolean;
}

const maxQuietLookup = 60 * 60_000;
const expiryBackoff = 30 * 60_000;
const submissionTimeout = 20_000;
const identity = /^\d{1,20}$/u;
const codePattern = /^[\p{L}\p{N}_-]{1,64}$/u;
type Journal = Record<string, unknown>;

const requestErrorText = {
  "invalid-input": "请求资料无效", transport: "连接失败", http: "HTTP 请求失败", response: "接口响应无效",
  api: "接口拒绝请求", refresh: "登录续期失败", "profile-changed": "档案已变更",
} as const;

function requestFailure(error: unknown) {
  if (!(error instanceof HoyoRequestError)) return "原因未知";
  const { status, retcode, code } = error;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) return `HTTP ${status}`;
  if (typeof retcode === "number" && Number.isInteger(retcode) && retcode >= -2_147_483_648 && retcode <= 2_147_483_647) {
    return `米游社返回 ${retcode}`;
  }
  return Object.hasOwn(requestErrorText, code) ? requestErrorText[code] : "原因未知";
}

function record(value: unknown): Journal | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Journal : undefined;
}

function isExpired(expiry: number | null, now: number) {
  return expiry !== null && now >= expiry;
}

function batch(result: unknown, game: PreviewGame, now: number) {
  const row = record(result);
  if (!row || row.status !== "available" || row.game !== game || typeof row.version !== "string" ||
    !/^\d+\.\d+$/u.test(row.version) || typeof row.actId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/u.test(row.actId) ||
    (typeof row.startAt === "number" && row.startAt > now) ||
    !Array.isArray(row.codes) || row.codes.length < redeemGames[game].count) return;
  const expiry = row.expiry === null ? null : record(row.expiry)?.ms;
  if (expiry === null) {
    // Without an official deadline, require a valid broadcast start from the provider.
    if (typeof row.startAt !== "number" || !Number.isSafeInteger(row.startAt) || row.startAt <= 0) return;
  } else if (typeof expiry !== "number" || !Number.isSafeInteger(expiry) || isExpired(expiry, now)) return;
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const item of row.codes) {
    const code = record(item)?.code;
    if (typeof code !== "string" || !codePattern.test(code) || seen.has(code.toLowerCase())) return;
    codes.push(code);
    seen.add(code.toLowerCase());
  }
  return { version: row.version, expiry, codes };
}

function selectRole(access: PreviewRoleAccess, game: PreviewGame) {
  const regions: readonly string[] = redeemGames[game].regions;
  const roles = access.roles.filter(role => identity.test(role.uid) && regions.includes(role.region));
  if (access.selectedUid) {
    const selected = roles.filter(role => role.uid === access.selectedUid);
    return selected.length === 1 ? selected[0] : undefined;
  }
  return roles.length === 1 ? roles[0] : undefined;
}

function legacyBatchKeys(accountId: string, game: PreviewGame, version: string, uid: string, explicit: boolean) {
  const key = (role: string) => createHash("sha256").update(JSON.stringify([accountId, game, version, role])).digest("hex");
  return explicit ? [key(uid)] : [key(uid), key("implicit")];
}

const createdJournal = "__lotusPreviewJournalVersion";

function createJournal(file: string, legacy: readonly string[], requireExisting: boolean) {
  const directory = dirname(file);
  async function read(inputPath: string): Promise<Journal | undefined> {
    try {
      const input = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await input.stat()).isFile()) throw new Error("前瞻自动兑换记录须为普通文件。");
        const data = record(JSON.parse(await input.readFile("utf8")));
        if (!data || Object.keys(data).some(key => key !== createdJournal && !/^[a-f0-9]{64}$/u.test(key))) {
          throw new Error("前瞻自动兑换记录格式无效。");
        }
        return data;
      } finally { await input.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  async function sources() {
    const [primary, ...historical] = await Promise.all([file, ...legacy].map(read));
    return { primary, historical: historical.filter(journal => journal !== undefined) };
  }

  function hasHistory({ primary, historical }: Awaited<ReturnType<typeof sources>>) {
    return Boolean((primary && !Object.hasOwn(primary, createdJournal)) ||
      historical.some(journal => !Object.hasOwn(journal, createdJournal)));
  }

  function canUse(source: Awaited<ReturnType<typeof sources>>, profile: PreviewProfile) {
    return hasHistory(source) || (!requireExisting && profile.allowNewJournal === true);
  }

  async function edit(change: (data: Journal, source: Awaited<ReturnType<typeof sources>>) => boolean) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = await lockFile(join(directory, `.${basename(file)}.sqlite`), "前瞻自动兑换记录");
    try {
      const source = await sources();
      const data = source.primary ?? { [createdJournal]: 1 };
      if (!change(data, source)) return false;
      const temporary = join(directory, `.${basename(file)}.${randomUUID()}.tmp`);
      try {
        const stage = await open(temporary, "wx", 0o600);
        try {
          await stage.writeFile(JSON.stringify(data));
          await stage.sync();
        } finally { await stage.close(); }
        await rename(temporary, file);
        const anchor = await open(directory, constants.O_DIRECTORY);
        try { await anchor.sync(); } finally { await anchor.close(); }
      } finally { await rm(temporary, { force: true }); }
      return true;
    } finally { lock.close(); }
  }

  return {
    async hasHistory() { return hasHistory(await sources()); },
    async eligible(profiles: readonly PreviewProfile[]) {
      const source = await sources();
      return profiles.filter(profile => canUse(source, profile));
    },
    claim(keys: readonly string[], time: number, profile: PreviewProfile) {
      return edit((data, source) => {
        if (!canUse(source, profile) ||
          keys.some(key => Object.hasOwn(data, key) || source.historical.some(journal => Object.hasOwn(journal, key)))) return false;
        for (const key of keys) data[key] = { time, status: "started" };
        return true;
      });
    },
    finish(keys: readonly string[], time: number) {
      return edit(data => {
        if (keys.some(key => {
          const value = record(data[key]);
          return value?.status !== "started" || value.time !== time;
        })) return false;
        for (const key of keys) data[key] = { time, status: "finished" };
        return true;
      });
    },
  };
}

export function createPreviewRedeemRunner({ journal, legacyJournal, lookup, listProfiles, readRoles, notify, now = Date.now,
  requireExistingJournal = false }: Options) {
  const journalPath = resolve(journal);
  const historicalPaths = new Set((typeof legacyJournal === "string" ? [legacyJournal] : legacyJournal ?? []).map(path => resolve(path)));
  historicalPaths.delete(journalPath);
  const store = createJournal(journalPath, [...historicalPaths], requireExistingJournal);
  const nextLookup = new Map<PreviewGame, number>();
  let running: Promise<void> | undefined;

  async function redeem(profile: PreviewProfile, game: PreviewGame, current: NonNullable<ReturnType<typeof batch>>, signal?: AbortSignal) {
    if (signal?.aborted || isExpired(current.expiry, now())) return;
    const access = await readRoles(profile, game, signal);
    if (!access || typeof access.accountId !== "string" || !identity.test(access.accountId)) return;
    const role = selectRole(access, game);
    if (!role) return;
    const keys = legacyBatchKeys(access.accountId, game, current.version, role.uid, Boolean(access.selectedUid));
    const time = now();
    if (signal?.aborted || isExpired(current.expiry, time) || !await store.claim(keys, time, profile)) return;

    const lines: string[] = [];
    let stopped = false;
    for (const code of current.codes) {
      if (signal?.aborted) return;
      const remaining = current.expiry === null ? submissionTimeout : current.expiry - now();
      if (stopped || remaining <= 0) {
        lines.push(`${code}：未提交`);
        continue;
      }
      const deadline = AbortSignal.timeout(Math.min(remaining, 2_147_483_647));
      const request = signal ? AbortSignal.any([signal, deadline]) : deadline;
      let status: PreviewSubmissionStatus = "unknown";
      try {
        const result = await access.submit(code, role, request);
        if (Object.hasOwn(resultText, result?.status)) status = result.status;
      } catch { /* A result may have been lost after the request reached the server. */ }
      lines.push(`${code}：${resultText[status]}`);
      stopped = status === "blocked" || status === "unknown";
    }
    if (signal?.aborted || !await store.finish(keys, time)) return;
    const reply = `${redeemGames[game].name} ${current.version} 前瞻 · 档案 ${profile.profileId}（UID ${role.uid}）\n${lines.join("\n")}`;
    if (access.notify) await access.notify(reply, signal);
    else await notify?.(profile, reply, signal);
  }

  function scan(signal?: AbortSignal, onError?: (diagnostic: string) => void) {
    return running ??= (async () => {
      if (signal?.aborted) return;
      const available = (await listProfiles(signal)).filter(profile => profile.games.length);
      if (signal?.aborted || !available.length) return;
      const profiles = await store.eligible(available);
      if (signal?.aborted || !profiles.length) return;
      for (const game of Object.keys(redeemGames) as PreviewGame[]) {
        if (signal?.aborted) return;
        const subscribers = profiles.filter(profile => profile.games.includes(game));
        if (!subscribers.length || (nextLookup.get(game) ?? 0) > now()) continue;
        let value: unknown;
        try { value = await lookup(game, signal); }
        catch (error) {
          if (!signal?.aborted) onError?.(`${redeemGames[game].name}前瞻查询未完成（${requestFailure(error)}）。`);
          continue;
        }
        if (signal?.aborted) return;
        const checked = now();
        const info = record(value);
        if (typeof info?.startAt === "number" && info.startAt > checked) nextLookup.set(game, Math.min(info.startAt, checked + maxQuietLookup));
        else if (info?.status === "expired" || info?.status === "unavailable") nextLookup.set(game, checked + expiryBackoff);
        const current = batch(value, game, checked);
        if (!current) continue;
        for (const profile of subscribers) {
          if (signal?.aborted || isExpired(current.expiry, now())) break;
          try { await redeem(profile, game, current, signal); }
          catch (error) {
            if (!signal?.aborted) onError?.(`${redeemGames[game].name} ${current.version} 前瞻自动兑换未完成（${requestFailure(error)}）。`);
          }
        }
      }
    })().finally(() => { running = undefined; });
  }

  return { scan, hasHistory: store.hasHistory };
}
