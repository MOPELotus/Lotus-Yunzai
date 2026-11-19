import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMiyousheWeb } from "../lib/miyoushe-web.ts";

const origin = new URL("https://miyoushe.example.org/");
const firstRevision = "a".repeat(64);
const updatedRevision = "b".repeat(64);

function get(path: string, cookie: string, site = "same-origin") {
  return new Request(new URL("/miyoushe/api/" + path, origin), { headers: { Cookie: cookie, "Sec-Fetch-Site": site } });
}
function post(path: string, cookie: string, body: object, site = origin.origin) {
  return new Request(new URL("/miyoushe/api/" + path, origin), { method: "POST",
    headers: { Cookie: cookie, Origin: site, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function gate() { return Promise.withResolvers<void>(); }

async function fixture(run: (options: {
  web: ReturnType<typeof createMiyousheWeb>; ticket: (profileId: number) => Promise<string>;
  revise: (next: string) => void; job: { started: ReturnType<typeof gate>; finish: ReturnType<typeof gate>; writes: number;
    signal?: AbortSignal };
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-manual-checkin-web-"));
  const controller = new AbortController();
  const signal = controller.signal;
  let revision = firstRevision;
  const job = { started: gate(), finish: gate(), writes: 0, signal: undefined as AbortSignal | undefined };
  const web = createMiyousheWeb({
    origin: () => origin, databasePath: join(directory, "sessions.sqlite"), assetDirectory: "web/miyoushe", signal,
    async loginIdentity(qq, profileId) { return qq + ":" + profileId; },
    async overview({ profileId }) { return { profileId, displayName: "测试档案", account: { deviceBound: true, loggedIn: true, roles: [] },
      todaySchedule: null, missions: null }; },
    manualCheckin: {
      async revision(_target, _signal, verify) { await verify(); return revision; },
      async run(target, sessionSignal, verify) {
        expect(target).toEqual({ qq: "42", profileId: 2 });
        expect(sessionSignal.aborted).toBe(false);
        job.signal = sessionSignal;
        job.started.resolve();
        await job.finish.promise;
        await verify();
        job.writes++;
        return { status: "completed", revision, message: "原神 · 游戏 成功 · 社区 关闭" };
      },
    },
  });
  async function ticket(profileId: number) {
    const command = "#米游社功能" + profileId;
    const text = await web.commands.fallback!(command, {
      message_type: "private", self_id: 99, user_id: 42, isMaster: false, normalizedMessage: command,
      privateCredentialSignal: signal, reply: () => true, isBotMaster: () => false,
    });
    const ticket = /#ticket=([\w-]{43})/u.exec(String(text))?.[1];
    const claimed = await web.handle(post("claim", "", { ticket }));
    expect(claimed?.status).toBe(204);
    return claimed!.headers.get("Set-Cookie")!.split(";", 1)[0]!;
  }
  try { await run({ web, ticket, job, revise(next) { revision = next; } }); }
  finally { job.finish.resolve(); controller.abort(); web.close(); await rm(directory, { recursive: true, force: true }); }
}

test("立即签到守同源，仅当前启动会话可追踪进度及读取同修订结果", async () => {
  await fixture(async ({ web, ticket, job, revise }) => {
    expect((await web.handle(get("checkin-run", "")))?.status).toBe(401);
    const own = await ticket(2), other = await ticket(1), sameSlot = await ticket(2);
    expect(await (await web.handle(get("overview", own)))?.json()).toMatchObject({ manualCheckinAvailable: true });
    expect((await web.handle(get("checkin-run", own, "same-site")))?.status).toBe(403);
    expect((await web.handle(post("checkin-run", own, {}, "https://other.example.org")))?.status).toBe(403);
    expect((await web.handle(post("checkin-run", own, { profileId: 1 })))?.status).toBe(400);
    const launch = new AbortController();
    const accepted = await web.handle(new Request(post("checkin-run", own, {}), { signal: launch.signal }));
    expect(accepted?.status).toBe(202);
    expect(await accepted?.json()).toMatchObject({ status: "running" });
    launch.abort();
    await job.started.promise;
    expect(await (await web.handle(get("checkin-run", own)))?.json()).toMatchObject({ status: "running" });
    expect(await (await web.handle(get("checkin-run", other)))?.json()).toEqual({ status: "idle" });
    expect(await (await web.handle(get("checkin-run", sameSlot)))?.json()).toEqual({ status: "idle" });
    expect((await web.handle(post("checkin-run", sameSlot, {})))?.status).toBe(409);
    expect(job.writes).toBe(0);
    job.finish.resolve();
    let result;
    for (let i = 0; i < 20; i++) {
      result = await (await web.handle(get("checkin-run", own)))?.json();
      if (result?.status === "completed") break;
      await Bun.sleep(10);
    }
    expect(result).toMatchObject({ status: "completed", message: "原神 · 游戏 成功 · 社区 关闭" });
    expect(job.writes).toBe(1);
    expect(await (await web.handle(get("checkin-run", sameSlot)))?.json()).toEqual({ status: "idle" });
    revise(updatedRevision);
    expect(await (await web.handle(get("checkin-run", own)))?.json()).toEqual({ status: "idle" });
  });
});

test("用户退出时，后台手动签到不能继续通过会话核验", async () => {
  await fixture(async ({ web, ticket, job }) => {
    const own = await ticket(2);
    expect((await web.handle(post("checkin-run", own, {})))?.status).toBe(202);
    await job.started.promise;
    expect((await web.handle(post("logout", own, {})))?.status).toBe(204);
    expect(job.signal?.aborted).toBe(true);
    job.finish.resolve();
    expect((await web.handle(get("checkin-run", own)))?.status).toBe(401);
    const session = await ticket(2);
    expect(await (await web.handle(get("checkin-run", session)))?.json()).toEqual({ status: "idle" });
    expect(job.writes).toBe(0);
  });
});
