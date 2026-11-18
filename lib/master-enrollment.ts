import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { MessageEvent } from "./messages.ts";

interface Permissions {
  readonly isMaster: (bot: number, user: number) => boolean;
  readonly masterIds: (bot: number) => readonly number[];
  readonly isTerminalMaster: () => boolean;
  readonly grant: (bot: number, user: number, approver: number | "stdin") => Promise<boolean>;
}

interface Application {
  readonly id: string;
  readonly bot: number;
  readonly user: number;
  readonly expires: number;
  signing?: { readonly approver: number; readonly digest: Buffer };
}

const applicationTtlMs = 5 * 60_000;
const maxApplications = 1024;
const enroll = "#设置主人";
const issue = "#设置主人验证码";
const invalid = "申请或验证码无效，或已过期。请重新申请。";
const writeFailed = "权限已变化或无法保存，请重新申请。";

export function matchesMasterEnrollment(message: string): boolean {
  return /^#设置主人(?:验证码)?(?:\s|$)/u.test(message.trimStart());
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function readId(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/u.test(value)) return;
  const id = Number(value);
  return isId(id) ? id : undefined;
}

function hash(code: string): Buffer {
  return createHash("sha256").update(code.toLowerCase()).digest();
}

export function createMasterEnrollment(permissions: Permissions, now: () => number = () => performance.now()) {
  const applications = new Map<string, Application>();
  const granting = new Set<string>();

  async function grant(bot: number, user: number, approver: number | "stdin"): Promise<string> {
    try {
      if (await permissions.grant(bot, user, approver)) return "已设置为当前机器人的主人。";
    } catch {
      // A storage exception must not expose the enrollment or its credentials.
    }
    return writeFailed;
  }

  async function handle(event: MessageEvent): Promise<string> {
    const [command, ...args] = event.msg.trim().split(/\s+/u);
    if (event.message_type === "terminal") {
      if (!permissions.isTerminalMaster()) return "请先在本机配置 stdin:stdin。";
      const bot = readId(args[0]);
      const user = readId(args[1]);
      if (command !== enroll || args.length !== 2 || !bot || !user || bot === user) {
        return "用法：#设置主人 <机器人QQ> <申请人QQ>。";
      }
      return grant(bot, user, "stdin");
    }

    const { self_id: bot, user_id: user } = event;
    if (event.message_type !== "private" || event.boundAccount !== true || !isId(bot) || !isId(user) || bot === user) {
      return "请在已绑定机器人的私聊中操作。";
    }

    const time = now();
    for (const [key, application] of applications) {
      if (application.expires <= time) applications.delete(key);
    }

    const key = `${bot}:${user}`;
    if (command === issue) {
      if (!permissions.isMaster(bot, user)) return "仅当前机器人的主人可签发验证码。";
      const id = args[0]?.toLowerCase();
      if (args.length !== 1 || !id || !/^[a-f0-9]{8}$/u.test(id)) return "用法：#设置主人验证码 <申请编号>。";
      const application = [...applications.values()].find((entry) => entry.bot === bot && entry.id === id);
      if (!application) return invalid;

      const code = randomBytes(8).toString("hex");
      application.signing = { approver: user, digest: hash(code) };
      return `申请人 QQ：${application.user}。验证码：${code}。请交给申请人私聊发送 #设置主人 <验证码>。`;
    }

    if (args.length > 1) return "用法：#设置主人，或 #设置主人 <验证码>。";
    if (permissions.isMaster(bot, user)) return "你已经是当前机器人的主人。";
    if (!permissions.masterIds(bot).length) return "当前机器人尚未设置主人，请先在本机配置。";
    if (granting.has(key)) return "主人设置正在处理。";

    const application = applications.get(key);
    const code = args[0];
    if (code === undefined) {
      let pending = application;
      if (!pending) {
        if (applications.size >= maxApplications) return "当前申请较多，请稍后重试。";
        let id: string;
        do {
          id = randomBytes(4).toString("hex");
        } while ([...applications.values()].some((entry) => entry.id === id && entry.bot === bot));
        pending = { id, bot, user, expires: time + applicationTtlMs };
        applications.set(key, pending);
      }
      return `申请编号：${pending.id}。请让当前机器人的主人在此机器人私聊中发送 #设置主人验证码 <编号>。申请 5 分钟内有效。`;
    }

    const signing = application?.signing;
    if (!signing || !/^[a-f0-9]{16}$/iu.test(code) || !timingSafeEqual(signing.digest, hash(code))) return invalid;
    // Invalidate before awaiting disk, including when the grant fails or is revoked.
    applications.delete(key);
    granting.add(key);
    try {
      if (!permissions.isMaster(bot, signing.approver)) return invalid;
      return await grant(bot, user, signing.approver);
    } finally {
      granting.delete(key);
    }
  }

  return async (event: MessageEvent): Promise<boolean> => {
    if (!matchesMasterEnrollment(event.msg)) return false;
    await event.reply(await handle(event));
    return true;
  };
}
