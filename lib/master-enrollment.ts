import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { MessageEvent } from "./messages.ts";

interface Permissions {
  readonly isMaster: (bot: number, user: number) => boolean;
  readonly masterIds: (bot: number) => readonly number[];
  readonly isTerminalMaster: () => boolean;
  readonly grant: (bot: number, user: number, approver: number | "stdin", isCurrent?: () => boolean) => Promise<boolean>;
}

interface Application {
  readonly id: string;
  readonly bot: number;
  readonly user: number;
  readonly adapter: "onebot" | "milky";
  readonly expires: number;
  signing?: { readonly approver: number; readonly digest: Buffer };
}

const applicationTtlMs = 5 * 60_000;
const maxApplications = 1024;
const enroll = "#设置主人";
const issue = "#设置主人验证码";
const invalid = $t("lib.master-enrollment.text_b1d1cc256d");
const writeFailed = $t("lib.master-enrollment.text_02c0ab25a7");

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

function isLive(guard?: () => boolean): boolean {
  try {
    return guard?.() === true;
  } catch {
    return false;
  }
}

export function createMasterEnrollment(permissions: Permissions, now: () => number = () => performance.now()) {
  const applications = new Map<string, Application>();
  const granting = new Set<string>();

  async function grant(bot: number, user: number, approver: number | "stdin", isCurrent?: () => boolean): Promise<string> {
    try {
      if (await permissions.grant(bot, user, approver, isCurrent)) return $t("lib.master-enrollment.text_89042535f5");
    } catch {
      // A storage exception must not expose the enrollment or its credentials.
    }
    return writeFailed;
  }

  async function handle(event: MessageEvent): Promise<string> {
    const [command, ...args] = event.msg.trim().split(/\s+/u);
    if (event.message_type === "terminal") {
      if (!permissions.isTerminalMaster()) return $t("lib.master-enrollment.text_1636694db5");
      const bot = readId(args[0]);
      const user = readId(args[1]);
      if (command !== enroll || args.length !== 2 || !bot || !user || bot === user) {
        return $t("lib.master-enrollment.text_7cec9adb9b");
      }
      return grant(bot, user, "stdin");
    }

    const { self_id: bot, user_id: user } = event;
    const adapter = event.adapter ?? "onebot";
    const isCurrent = adapter === "milky" ? event.isOwnerEnrollmentSession : undefined;
    const bound = adapter === "milky" ? isLive(isCurrent) : event.boundAccount === true;
    if (event.message_type !== "private" || !bound || !isId(bot) || !isId(user) || bot === user) {
      return $t("lib.master-enrollment.text_8e00429d69");
    }

    const time = now();
    for (const [key, application] of applications) {
      if (application.expires <= time) applications.delete(key);
    }

    const ownerKey = `${bot}:${user}`;
    const key = `${adapter}:${ownerKey}`;
    if (command === issue) {
      if (!permissions.isMaster(bot, user)) return $t("lib.master-enrollment.text_69e7e55ac7");
      const id = args[0]?.toLowerCase();
      if (args.length !== 1 || !id || !/^[a-f0-9]{8}$/u.test(id)) return $t("lib.master-enrollment.text_3bc994a50d");
      const application = [...applications.values()].find((entry) => entry.adapter === adapter && entry.bot === bot && entry.id === id);
      if (!application) return invalid;

      const code = randomBytes(8).toString("hex");
      application.signing = { approver: user, digest: hash(code) };
      return $t("lib.master-enrollment.text_0dfeed2a33", { "user": application.user, "code": code });
    }

    if (args.length > 1) return $t("lib.master-enrollment.text_ecb35e92f7");
    if (permissions.isMaster(bot, user)) return $t("lib.master-enrollment.text_29fec4bac2");
    if (!permissions.masterIds(bot).length) return $t("lib.master-enrollment.text_d697412277");
    if (granting.has(ownerKey)) return $t("lib.master-enrollment.text_fdfa52d4a4");

    const application = applications.get(key);
    const code = args[0];
    if (code === undefined) {
      let pending = application;
      if (!pending) {
        if (applications.size >= maxApplications) return $t("lib.master-enrollment.text_ee915188ce");
        let id: string;
        do {
          id = randomBytes(4).toString("hex");
        } while ([...applications.values()].some((entry) => entry.id === id && entry.bot === bot));
        pending = { id, bot, user, adapter, expires: time + applicationTtlMs };
        applications.set(key, pending);
      }
      return $t("lib.master-enrollment.text_71686dbcb2", { "id": pending.id });
    }

    const signing = application?.signing;
    if (!signing || !/^[a-f0-9]{16}$/iu.test(code) || !timingSafeEqual(signing.digest, hash(code))) return invalid;
    // Invalidate before awaiting disk, including when the grant fails or is revoked.
    applications.delete(key);
    granting.add(ownerKey);
    try {
      if (!permissions.isMaster(bot, signing.approver)) return invalid;
      return await grant(bot, user, signing.approver, isCurrent);
    } finally {
      granting.delete(ownerKey);
    }
  }

  return async (event: MessageEvent): Promise<boolean> => {
    if (!matchesMasterEnrollment(event.msg)) return false;
    await event.reply(await handle(event));
    return true;
  };
}
