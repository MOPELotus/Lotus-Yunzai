import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("gacha", messageCatalog.messages);
import { gameCommandProfileId, MAX_PROFILE_ID, ProfileError, type GameRole } from "@lotus-yunzai/account";

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
    return $t("file-import.text_677178ee12", { "prefix": prefix, "profileId": profileId });
  }
  signal.addEventListener("abort", () => {
    for (const [scope, request] of pending) if (request.owner === owner) pending.delete(scope);
  }, { once: true });

  return async (context: GachaFileImportContext, command: RegExpExecArray | null) => {
    const { adapter, self_id, user_id, group_id, message_type, attachment } = context;
    const target = message_type === "group" && validId(group_id) ? `group:${group_id}`
      : message_type === "private" ? "private" : undefined;
    if (!target || !validId(self_id) || !validId(user_id)) {
      if (command) return $t("file-import.text_63b1e8c9be", { "gameName": gameName });
      return;
    }
    if (signal.aborted) return;
    const qq = String(user_id);
    const scope = `${adapter ?? "onebot"}:${self_id}:${qq}:${target}`;
    if (command) {
      const profileId = gameCommandProfileId(prefix === "*" ? "sr" : "gs", command[2]);
      if (profileId > MAX_PROFILE_ID) return;
      if (message_type === "group" && !command[1]) {
        return $t("file-import.text_8434f7549f", { "prefix": prefix, "profileId": profileId });
      }
      if (context.canReadAttachments !== true) return $t("file-import.text_ca33136ba3");
      const request: PendingImport = { owner, profileId, role: savedRole(qq, profileId), expires: performance.now() + importTimeoutMs };
      pending.set(scope, request);
      try {
        await request.role;
        if (pending.get(scope) === request && !signal.aborted) {
          setTimeout(async () => {
            if (pending.get(scope) !== request) return;
            pending.delete(scope);
            if (!signal.aborted) {
              try { await context.reply($t("file-import.text_f011502428", { "value1": retry(profileId) })); }
              catch { /* The original session may have closed. */ }
            }
          }, importTimeoutMs).unref();
          return $t("file-import.text_c857bd3f2b");
        }
      } catch (error) {
        if (pending.get(scope) === request) pending.delete(scope);
        if (!signal.aborted) return failure(error, profileId) ?? $t("file-import.text_9bcf841c71", { "gameName": gameName });
      }
      return;
    }

    if (!attachment || !/\.json$/iu.test(attachment.name)) return;
    const request = pending.get(scope);
    if (!request || request.owner !== owner) return;
    pending.delete(scope);
    const { profileId } = request;
    if (request.expires <= performance.now()) return $t("file-import.text_f011502428", { "value1": retry(profileId) });
    try {
      const role = await request.role;
      async function verifyProfile() {
        signal.throwIfAborted();
        const current = await savedRole(qq, profileId).catch(() => undefined);
        if (current?.uid !== role.uid) throw new ProfileError("changed", $t("file-import.text_2db803a269"));
        signal.throwIfAborted();
      }
      await verifyProfile();
      const bytes = await attachment.read(signal);
      if (signal.aborted) return;
      if (!bytes) return $t("file-import.text_a003cbb555", { "value1": retry(profileId) });
      let input: unknown;
      try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { return $t("file-import.text_f079d2ae58"); }
      const summary = await importDocument(input, { qq, profileId, role, verifyProfile });
      if (!signal.aborted) return summary;
    } catch (error) {
      if (!signal.aborted) return failure(error, profileId) ?? $t("file-import.text_168e2b032d", { "gameName": gameName });
    }
  };
}
