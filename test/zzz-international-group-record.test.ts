import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModule } from "../plugins/zzz/index.ts";

test("绝区零国际角色资料接受本人真实群会话，仅发送同档国际服凭据", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzz-international-group-"));
  const previous = Bun.env.LOTUS_PROFILE_DIR;
  const session = new AbortController();
  let requests = 0;
  try {
    Bun.env.LOTUS_PROFILE_DIR = root;
    await writeFile(join(root, "42-2.yaml"), `user: { qq: "42" }
profile: { id: 2 }
account:
  cookie: "cookie_token=domestic-only; account_id=43"
  stoken: fixture-stoken
  stuid: "43"
  current_uid: { zzz: "1000000023" }
games:
  os:
    verified_account_id: "44"
    verified_realm: US
    verified_activity_cookie: "ltuid=44; ltoken=international-fixture"
`);
    const module = createModule({ signal: new AbortController().signal,
      async lockFile() { throw Error("只读查询不应写锁"); }, async hoyoTransport(url, request) {
        requests++;
        expect(url.origin + url.pathname).toBe("https://api-account-os.hoyolab.com/binding/api/getUserGameRolesByLtoken");
        expect(url.search).toBe("?game_biz=nap_global");
        expect(new Headers(request.headers).get("cookie")).toBe("ltuid=44; ltoken=international-fixture");
        expect(request.signal?.aborted).toBe(false);
        return Response.json({ retcode: -100, message: "fixture expired", data: null });
      } });
    const event = { normalizedMessage: "#绝区零card2", user_id: 42, self_id: 99, group_id: 701,
      message_id: 1, message_type: "group", groupActivitySignal: session.signal, reply() { return true; } };
    for (const denied of [{ ...event, groupActivitySignal: undefined }, { ...event, sub_type: "anonymous" },
      { ...event, isDelegated: true }, { ...event, sender: { user_id: 43 } }]) {
      expect(await module.fallback(event.normalizedMessage, denied)).toContain("本人绝区零国际服角色资料");
    }
    expect(requests).toBe(0);
    expect(await module.fallback(event.normalizedMessage, event)).toContain("Cookie");
    expect(requests).toBe(1);
    session.abort();
    expect(await module.fallback(event.normalizedMessage, event)).toContain("本人绝区零国际服角色资料");
    expect(requests).toBe(1);
  } finally {
    if (previous === undefined) delete Bun.env.LOTUS_PROFILE_DIR;
    else Bun.env.LOTUS_PROFILE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
