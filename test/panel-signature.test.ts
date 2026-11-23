import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { containsPanelSignatureChallenge, createPanelSignatureService, matchPanelSignatureCommand } from "../lib/panel-signature.ts";

const gsUid = "100000042";
const token = "LY-0011223344556677";
const signal = new AbortController().signal;
const session = { bot: 99, user: 42, adapter: "onebot" as const, signal, isCurrent: () => true };
const bind = { game: "gs", action: "begin", uid: gsUid } as const;
const verify = { ...bind, action: "verify" } as const;

test("原神与星铁绑定及显式 UID 的本地导出和登录档案命令互不覆盖", () => {
  expect(matchPanelSignatureCommand("#绑定原神uid100000042")).toEqual(bind);
  expect(matchPanelSignatureCommand("*验证UID 100000042")).toMatchObject({ game: "sr", action: "verify", uid: gsUid });
  expect(matchPanelSignatureCommand("#原神导出面板 UID100000042")).toEqual({ game: "gs", action: "export", uid: gsUid });
  expect(matchPanelSignatureCommand("#原神导出面板 档案2")).toBeUndefined();
  expect(matchPanelSignatureCommand("*导出面板数据 100000042")).toBeUndefined();
  expect(matchPanelSignatureCommand("#ark绑定原神uid100000042")).toBeUndefined();
  expect(containsPanelSignatureChallenge(`口令 ${token}。`)).toBe(true);
  expect(containsPanelSignatureChallenge("其他文本 LY-example")).toBe(false);
});

test("签名口令须实际送达，错误回包遵守退避，消耗验证后按好友作用域和时限读取", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-signature-"));
  try {
    let clock = 100000, signature = "unrelated";
    const reads: string[] = [];
    const service = createPanelSignatureService(lockFile, { directory, now: () => clock, challenge: () => token,
      readSignature: async (game, uid, request) => {
        expect(request).toBe(signal);
        reads.push(`${game}:${uid}`);
        return { state: "ready", signature, ttlSeconds: 42 };
      },
    });
    const offer = await service.run(bind, session);
    if (!offer || typeof offer === "string") throw new Error("没有确认回执");
    expect(offer.message).toContain(token);
    expect(await service.run(verify, session)).toContain("没有对应的待验证");
    expect(reads).toEqual([]);
    expect(await readFile(join(directory, "onebot/gs/42/99.json"), "utf8")).not.toContain(token);
    await offer.onDelivered();
    for (const wrong of [{ ...session, user: 43 }, { ...session, bot: 98 }, { ...session, adapter: "milky" as const }]) {
      expect(await service.run(verify, wrong)).toContain("没有对应的待验证");
    }
    expect(await service.run({ ...verify, uid: "100000043" }, session)).toContain("没有对应的待验证");
    expect(await service.run(verify, session)).toContain("尚未读到匹配签名");
    expect(await service.run(verify, session)).toContain("42 秒后重试");
    expect(reads).toEqual([`gs:${gsUid}`]);
    signature = token;
    clock += 42000;
    expect(await service.run(verify, session)).toContain("已验证");
    expect(await service.run(verify, session)).toContain("没有对应的待验证");
    const authorization = await service.authorization("gs", gsUid, session);
    expect(await authorization?.()).toBe(true);
    expect(await service.authorization("sr", gsUid, session)).toBeUndefined();
    expect(await service.authorization("gs", gsUid, { ...session, bot: 98 })).toBeUndefined();
    clock += 30 * 60_000;
    expect(await authorization?.()).toBe(false);
    expect(await service.authorization("gs", gsUid, session)).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("撤回或替换中的旧回执不能启用口令，核验途中撤回不产生导出权限", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-signature-revocation-"));
  try {
    let id = 1;
    const response = Promise.withResolvers<{ state: "ready"; signature: string; ttlSeconds: number }>();
    const requested = Promise.withResolvers<void>();
    const code = () => `LY-${String(id++).padStart(16, "0")}`;
    const revoke = { ...bind, action: "revoke" } as const;
    const service = createPanelSignatureService(lockFile, { directory, challenge: code,
      readSignature() { requested.resolve(); return response.promise; },
    });
    const earlier = await service.run(bind, session);
    const newer = await service.run(bind, session);
    if (!earlier || typeof earlier === "string" || !newer || typeof newer === "string") throw new Error("没有确认回执");
    await earlier.onDelivered();
    expect(await service.run(verify, session)).toContain("没有对应的待验证");
    await newer.onDelivered();
    const running = service.run(verify, session);
    await requested.promise;
    expect(await service.run(revoke, session)).toContain("已撤回");
    response.resolve({ state: "ready", signature: "LY-0000000000000002", ttlSeconds: 60 });
    expect(await running).toContain("口令已更新或撤回");
    await newer.onDelivered();
    expect(await service.run(verify, session)).toContain("没有对应的待验证");
    expect(await service.authorization("gs", gsUid, session)).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
