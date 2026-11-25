import { expect, test } from "bun:test";
import { ProfileError } from "../packages/account/index.ts";
import { checkinGroupRegistrationCommands } from "../lib/checkin-group-registration-commands.ts";
import type { MessageFallbackContext } from "../lib/commands.ts";
import { segment } from "../lib/messages.ts";

const group = {
  message_type: "group", self_id: 12, group_id: 700, user_id: 51, isMaster: true,
  normalizedMessage: "#注册本群签到2", reply: () => true, isBotMaster: () => true,
} as const satisfies MessageFallbackContext;

function profile(qq: number, profileId = 2, loggedIn = true) {
  return { qq: String(qq), profileId, loggedIn };
}

type Register = Parameters<typeof checkinGroupRegistrationCommands>[0]["profiles"]["registerGroupCheckin"];

function fixture({
  signal = new AbortController().signal,
  rows = [profile(51)],
  register = async () => ({ status: "updated", revision: "saved" }),
  add = async () => {},
  renderCard = false,
}: {
  readonly signal?: AbortSignal;
  readonly rows?: ReturnType<typeof profile>[];
  readonly register?: Register;
  readonly add?: (qq: string, id: number, revision: string) => Promise<void>;
  readonly renderCard?: boolean;
} = {}) {
  const trace: string[] = [];
  const png = Buffer.from("synthetic card result");
  return {
    trace, png,
    async invoke(context: Partial<MessageFallbackContext> = {}) {
      const assembled = {
        ...group,
        async listCheckinGroupMembers() {
          trace.push("live");
          return [{ id: 51 }];
        },
        ...context,
      };
      const command = checkinGroupRegistrationCommands({
        profiles: {
          async listCheckinProfiles(ids, profileId) {
            trace.push(`profiles ${[...ids]} P${profileId}`);
            return rows;
          },
          async checkinSettings(qq, id) {
            trace.push(`read ${qq} P${id}`);
            return { revision: `latest-${qq}`, loggedIn: true };
          },
          async registerGroupCheckin(qq, id, revision, groupId, nickname) {
            trace.push(`write ${qq} P${id} ${revision} group=${groupId}`);
            return register(qq, id, revision, groupId, nickname);
          },
        },
        signal,
        canRegister(actor) {
          trace.push("permission");
          return actor.isMaster;
        },
        async addRegisteredProfile(qq, id, revision) {
          trace.push(`schedule ${qq} P${id} ${revision}`);
          return add(qq, id, revision);
        },
        async render() {
          if (!renderCard) throw new Error("渲染失败");
          return { png };
        },
      });
      return command.fallback?.(assembled.normalizedMessage, assembled);
    },
  };
}

test("权限与完整实时名单先于所有档案读取", async () => {
  const { invoke, trace } = fixture();
  expect(await invoke({ message_type: "private" })).toContain("请在目标群内执行");
  expect(await invoke({ normalizedMessage: "#注册本群签到256" })).toBe("档案编号须在 1 到 255 之间。");
  expect(await invoke({ isMaster: false })).toContain("无权");
  expect(trace.splice(0)).toEqual(["permission"]);
  for (const listCheckinGroupMembers of [
    undefined,
    async () => { throw new Error("不应暴露的群成员详情"); },
    async () => [{ id: 61 }],
    async () => [{ id: 51 }, { id: 2 ** 53 }],
    async () => [{ id: 51, name: "甲" }, { id: 51, name: "乙" }],
  ]) {
    expect(await invoke({ listCheckinGroupMembers })).toBe("无法读取本群成员列表，暂时不能批量注册签到。");
  }
  expect(trace).toEqual(["permission", "permission", "permission", "permission", "permission"]);
});

test("只改本群指定档案，部分失败不会阻断其他档案或暴露异常原文", async () => {
  const { invoke, trace } = fixture({
    rows: [profile(51), profile(52), profile(53, 2, false), profile(54, 1), profile(55), profile(56), profile(57), profile(99)],
    async register(qq, _id, _revision, _groupId, nickname) {
      expect(nickname).toBe(qq === "56" ? undefined : `成员${qq}`);
      if (qq === "55") throw new ProfileError("changed", "secret-stale");
      if (qq === "56") throw new Error("secret-upstream");
      return { status: qq === "52" ? "existing" : "updated", revision: `saved-${qq}` };
    },
    async add(qq) { if (qq === "57") throw new Error("secret-plan"); },
  });
  const result = await invoke({
    group_id: 800,
    async listCheckinGroupMembers() {
      trace.push("live 800");
      return Array.from({ length: 7 }, (_, index) => ({ id: 51 + index, name: index === 5 ? "\n" : `成员\n${51 + index}` }));
    },
  });
  expect(trace).toEqual([
    "permission", "live 800", "profiles 51,52,53,54,55,56,57 P2",
    "read 51 P2", "write 51 P2 latest-51 group=800", "schedule 51 P2 saved-51",
    "read 52 P2", "write 52 P2 latest-52 group=800", "schedule 52 P2 saved-52",
    "read 55 P2", "write 55 P2 latest-55 group=800",
    "read 56 P2", "write 56 P2 latest-56 group=800",
    "read 57 P2", "write 57 P2 latest-57 group=800", "schedule 57 P2 saved-57",
  ]);
  expect(result).toContain("群号：800");
  expect(result).toContain("群成员：7");
  expect(result).toContain("注册/已有/跳过：2/1/4");
  expect(result).toContain("已存在 P2");
  expect(result).toContain("缺少 cookie/stoken");
  expect(result).toContain("未找到档案");
  expect(result).toContain("档案已变化，请重试");
  expect(result).toContain("暂时无法保存档案");
  expect(result).toContain("群成员 (56)");
  expect(result).toContain("签到计划暂未更新：1 个档案");
  expect(result).not.toContain("secret");
});

test("默认档案保持图卡回执，注册与已有样例分开限制", async () => {
  const items = Array.from({ length: 12 }, (_, index) => profile(51 + index, 1));
  const { invoke, png, trace } = fixture({ rows: items, renderCard: true });
  expect(await invoke({ normalizedMessage: "#注册本群签到" })).toEqual(segment.image(png));
  expect(trace).toContain("profiles 51 P1");

  const fallback = fixture({ rows: items });
  const result = String(await fallback.invoke({
    normalizedMessage: "#注册本群签到", async listCheckinGroupMembers() {
      return Array.from({ length: 20 }, (_, index) => ({ id: 51 + index }));
    },
  }));
  expect(result).toContain("注册/已有/跳过：12/0/8");
  expect(result.match(/已注册 P1/gu)).toHaveLength(10);
  expect(result.match(/跳过 · 未找到档案/gu)).toHaveLength(6);
});

test("停机时保留已保存的档案，停止补位和后续成员处理", async () => {
  const controller = new AbortController();
  const { invoke, trace } = fixture({
    rows: [profile(51), profile(52)], signal: controller.signal,
    async register() { controller.abort(); return { status: "updated", revision: "saved" }; },
  });
  expect(await invoke({ async listCheckinGroupMembers() { return [{ id: 51 }, { id: 52 }]; } })).toBeUndefined();
  expect(trace).toEqual(["permission", "profiles 51,52 P2", "read 51 P2", "write 51 P2 latest-51 group=700"]);
});
