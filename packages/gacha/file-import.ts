import { MAX_PROFILE_ID, ProfileError, type GameRole } from "@lotus-yunzai/account";

const importTimeoutMs = 120_000;

export interface GachaFileImportContext {
  readonly adapter?: string;
  readonly self_id?: number;
  readonly user_id?: number;
  readonly group_id?: number;
  readonly message_type?: string;
  readonly attachment?: { readonly name: string; read(signal?: AbortSignal): Promise<Uint8Array | undefined> };
  readonly canReadAttachments?: boolean;
  reply(message: string): unknown;
}

interface PendingImport {
  readonly owner: symbol;
  readonly profileId: number;
  readonly role: Promise<GameRole>;
  readonly expires: number;
}

interface ImportRole {
  readonly qq: string;
  readonly profileId: number;
  readonly role: GameRole;
  readonly verifyProfile: () => Promise<void>;
}

const pending = new Map<string, PendingImport>();

function validId(id: unknown): id is number {
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
}

export function createGachaFileImport({ prefix, gameName, signal, savedRole, importDocument, failure }: {
  readonly prefix: "#" | "*";
  readonly gameName: string;
  readonly signal: AbortSignal;
  readonly savedRole: (qq: string, profileId: number) => Promise<GameRole>;
  readonly importDocument: (input: unknown, request: ImportRole) => Promise<string>;
  readonly failure: (error: unknown, profileId: number) => string | undefined;
}) {
  const owner = Symbol(gameName);
  function retry(profileId: number) {
    return `${prefix}导入记录${profileId === 1 ? "" : profileId}`;
  }
  signal.addEventListener("abort", () => {
    for (const [scope, request] of pending) if (request.owner === owner) pending.delete(scope);
  }, { once: true });

  return async (context: GachaFileImportContext, command: RegExpExecArray | null) => {
    const { adapter, self_id, user_id, group_id, message_type, attachment } = context;
    const target = message_type === "group" && validId(group_id) ? `group:${group_id}`
      : message_type === "private" ? "private" : undefined;
    if (!target || !validId(self_id) || !validId(user_id)) {
      if (command) return `请从登录档案对应的 QQ 会话导入${gameName}抽卡记录。`;
      return;
    }
    if (signal.aborted) return;
    const qq = String(user_id);
    const scope = `${adapter ?? "onebot"}:${self_id}:${qq}:${target}`;
    if (command) {
      const profileId = Number(command[2] ?? 1);
      if (profileId > MAX_PROFILE_ID) return;
      if (message_type === "group" && !command[1]) {
        return `建议私聊导入，若你确认要在此导入，请发送【${prefix}强制导入记录${profileId === 1 ? "" : profileId}】。`;
      }
      if (context.canReadAttachments !== true) return "当前网关会话暂不支持接收抽卡文件。";
      const request: PendingImport = { owner, profileId, role: savedRole(qq, profileId), expires: performance.now() + importTimeoutMs };
      pending.set(scope, request);
      try {
        await request.role;
        if (pending.get(scope) === request && !signal.aborted) {
          setTimeout(async () => {
            if (pending.get(scope) !== request) return;
            pending.delete(scope);
            if (!signal.aborted) {
              try { await context.reply(`导入等待已超时，请重新发送 ${retry(profileId)}。`); }
              catch { /* The original session may have closed. */ }
            }
          }, importTimeoutMs).unref();
          return "请发送 JSON 文件。";
        }
      } catch (error) {
        if (pending.get(scope) === request) pending.delete(scope);
        if (!signal.aborted) return failure(error, profileId) ?? `无法读取当前${gameName}档案。`;
      }
      return;
    }

    if (!attachment || !/\.json$/iu.test(attachment.name)) return;
    const request = pending.get(scope);
    if (!request || request.owner !== owner) return;
    pending.delete(scope);
    const { profileId } = request;
    if (request.expires <= performance.now()) return `导入等待已超时，请重新发送 ${retry(profileId)}。`;
    try {
      const role = await request.role;
      async function verifyProfile() {
        signal.throwIfAborted();
        const current = await savedRole(qq, profileId).catch(() => undefined);
        if (current?.uid !== role.uid) throw new ProfileError("changed", "抽卡档案角色已变化。");
        signal.throwIfAborted();
      }
      await verifyProfile();
      const bytes = await attachment.read(signal);
      if (signal.aborted) return;
      if (!bytes) return `无法从网关读取该 JSON 文件，请重新发送 ${retry(profileId)} 后再上传。`;
      let input: unknown;
      try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { return "文件内容不是有效的 UTF-8 JSON，请核对后重新导入。"; }
      const summary = await importDocument(input, { qq, profileId, role, verifyProfile });
      if (!signal.aborted) return summary;
    } catch (error) {
      if (!signal.aborted) return failure(error, profileId) ?? `${gameName}抽卡记录导入失败，请检查 JSON 和本地历史。`;
    }
  };
}
