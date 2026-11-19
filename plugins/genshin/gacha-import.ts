import { MAX_PROFILE_ID, ProfileError, type createProfileStore } from "@lotus-yunzai/account";
import { genshinGachaThemeDirectory, readGenshinUigfItems } from "./gacha-detail-source.ts";
import type { createGenshinGachaHistoryStore } from "./gacha-store.ts";
import { selectGenshinUigf } from "./gacha-uigf.ts";

export const gachaImportCommand = /^#?(?:原神)?(强制)?导入记录(?:json)?([1-9]\d{0,2})?$/u;
const importTimeoutMs = 120_000;

interface ImportContext {
  readonly adapter?: string;
  readonly self_id?: number;
  readonly user_id?: number;
  readonly group_id?: number;
  readonly message_type?: string;
  readonly attachment?: { readonly name: string; read(signal?: AbortSignal): Promise<Uint8Array | undefined> };
  readonly canReadAttachments?: boolean;
  reply(message: string): unknown;
}

type Profiles = Pick<ReturnType<typeof createProfileStore>, "savedRole">;
type History = Pick<ReturnType<typeof createGenshinGachaHistoryStore>, "merge">;
type PendingImport = {
  readonly profileId: number;
  readonly role: ReturnType<Profiles["savedRole"]>;
  readonly expires: number;
};

function validId(id: unknown): id is number {
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
}

function legacyMiaoTime(input: unknown): boolean {
  if (typeof input !== "object" || !input || !("info" in input)) return false;
  const { info } = input;
  return typeof info === "object" && info !== null && "export_app" in info && info.export_app === "Miao-Yunzai" &&
    "version" in info && info.version === "v4.0";
}

function profileFailure(error: unknown, profileId: number): string | undefined {
  if (!(error instanceof ProfileError)) return;
  if (error.code === "missing") return `[荷花插件]请先登录 profile ${profileId}。`;
  if (error.code === "role-missing") return `[荷花插件]profile ${profileId} 没有同步原神 UID。`;
  if (error.code === "changed") return "原神档案角色已变化，请重新导入。";
}

export function createGenshinGachaImport(profiles: Profiles, history: History, signal: AbortSignal) {
  const pending = new Map<string, PendingImport>();

  return async (context: ImportContext, command: RegExpExecArray | null) => {
    const { adapter, self_id, user_id, group_id, message_type, attachment } = context;
    const target = message_type === "group" && validId(group_id) ? `group:${group_id}`
      : message_type === "private" ? "private" : undefined;
    if (!target || !validId(self_id) || !validId(user_id)) {
      if (command) return "请从登录档案对应的 QQ 会话导入原神抽卡记录。";
      return;
    }
    if (signal.aborted) return;
    const qq = String(user_id);
    const scope = `${adapter ?? "onebot"}:${self_id}:${qq}:${target}`;
    if (command) {
      const profileId = Number(command[2] ?? 1);
      if (profileId > MAX_PROFILE_ID) return;
      if (message_type === "group" && !command[1]) {
        return `建议私聊导入，若你确认要在此导入，请发送【#强制导入记录${profileId === 1 ? "" : profileId}】。`;
      }
      if (context.canReadAttachments !== true) return "当前网关会话暂不支持接收抽卡文件。";
      const request: PendingImport = { profileId, role: profiles.savedRole(qq, profileId, "gs"), expires: performance.now() + importTimeoutMs };
      pending.set(scope, request);
      try {
        await request.role;
        if (pending.get(scope) === request && !signal.aborted) {
          setTimeout(async () => {
            if (pending.get(scope) !== request) return;
            pending.delete(scope);
            if (!signal.aborted) {
              try { await context.reply("导入等待已超时，请重新发送 #导入记录。"); }
              catch { /* The original session may have closed. */ }
            }
          }, importTimeoutMs).unref();
          return "请发送 JSON 文件。";
        }
      } catch (error) {
        if (pending.get(scope) === request) pending.delete(scope);
        if (!signal.aborted) return profileFailure(error, profileId) ?? "无法读取当前原神档案。";
      }
      return;
    }

    if (!attachment || !/\.json$/iu.test(attachment.name)) return;
    const request = pending.get(scope);
    if (!request) return;
    pending.delete(scope);
    if (request.expires <= performance.now()) return "导入等待已超时，请重新发送 #导入记录。";
    const { profileId } = request;
    try {
      const { uid } = await request.role;
      async function verifyProfile() {
        signal.throwIfAborted();
        const current = await profiles.savedRole(qq, profileId, "gs").catch(() => undefined);
        if (current?.uid !== uid) throw new ProfileError("changed", "原神档案角色已变化。");
        signal.throwIfAborted();
      }
      await verifyProfile();
      const bytes = await attachment.read(signal);
      if (signal.aborted) return;
      if (!bytes) return "无法从网关读取该 JSON 文件，请重新发送 #导入记录后再上传。";
      let input: unknown;
      try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { return "文件内容不是有效的 UTF-8 JSON，请核对后重新导入。"; }

      const resolveItem = await readGenshinUigfItems(genshinGachaThemeDirectory());
      const snapshot = selectGenshinUigf(input, { uid, resolveItem, legacyMiaoServerTime: legacyMiaoTime(input) });
      const result = await history.merge({ qq, uid }, snapshot, verifyProfile);
      if (signal.aborted) return;
      const counts = new Map(snapshot.pools.map(({ type, records }) => [type, records.length]));
      const lines = result.pools.flatMap(({ type, name, total, added }) => {
        const count = counts.get(type);
        return count ? [`${name}记录：读取 ${count} 条，新增 ${added} 条，共 ${total} 条`] : [];
      });
      return [`UID ${uid} · 原神抽卡记录导入成功`, ...lines,
        `可使用 #抽卡记录${profileId === 1 ? "" : profileId} 查看。`].join("\n");
    } catch (error) {
      if (signal.aborted) return;
      return profileFailure(error, profileId) ?? (error instanceof TypeError && /^(?:UIGF|该 UIGF)/u.test(error.message)
        ? error.message : "原神抽卡记录导入失败，请检查 JSON 和本地历史。");
    }
  };
}
