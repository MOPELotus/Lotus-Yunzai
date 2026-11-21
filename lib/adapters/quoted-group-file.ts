import type { QuotedMessage, RecallResult } from "../messages.ts";

type Protocol = "onebot" | "milky";
type GroupFileReference = { readonly id: string; readonly size: number; readonly uploader: number; readonly busId?: number };
export interface QuotedGroupFileRemoval {
  readonly id: string;
  locate(active: () => boolean): Promise<(() => Promise<RecallResult>) | undefined>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function opaqueId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0 && value.length <= 1024 && value.isWellFormed() &&
      !/[\s\p{Cc}\p{Cf}]/u.test(value) && value !== "/" && value !== "." && value !== "..") return value;
}

function integer(value: unknown): number | undefined {
  const number = typeof value === "string" && /^(?:0|[1-9]\d{0,15})$/u.test(value) ? Number(value) : value;
  if (typeof number === "number" && Number.isSafeInteger(number) && number >= 0) return number;
}

function businessId(value: unknown): number | undefined {
  const id = integer(value);
  if (id !== undefined && id > 0 && id <= 0xFFFF_FFFF) return id;
}

export function quotedGroupFile(source: QuotedMessage, protocol: Protocol): GroupFileReference | undefined {
  const part = source.message[0];
  if (part?.type !== "file" || source.message.filter(({ type }) => type === "file").length !== 1) return;
  const id = opaqueId(protocol === "onebot" ? part.file_id : part.file);
  const size = integer(protocol === "onebot" ? part.file_size : part.size);
  const busId = protocol === "onebot" ? businessId(part.busid) : undefined;
  if (id === undefined || size === undefined || (protocol === "onebot" && part.busid !== undefined && busId === undefined)) return;
  return { id, size, uploader: source.user_id, busId };
}

export async function findQuotedGroupFile(
  group: number, source: GroupFileReference, protocol: Protocol, signal: AbortSignal, active: () => boolean,
  read: (folder: string, signal: AbortSignal) => Promise<unknown>,
): Promise<{ readonly busId?: number } | undefined> {
  const folders = ["/"];
  const seen = new Set(folders);
  const reading = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
  try {
    for (const folder of folders) {
      if (!active() || reading.aborted) return;
      const page = await read(folder, reading);
      if (!active() || reading.aborted || !record(page) || !Array.isArray(page.files) || !Array.isArray(page.folders)) return;
      const matches = page.files.filter((row): row is Record<string, unknown> => record(row) && row.file_id === source.id);
      if (matches.length) {
        if (matches.length !== 1) return;
        const row = matches[0]!;
        if (integer(row.group_id) !== group) return;
        if (protocol === "milky") {
          if (row.parent_folder_id === folder && integer(row.uploader_id) === source.uploader && integer(row.file_size) === source.size) return {};
        } else {
          const busId = businessId(row.busid);
          const size = integer(row.file_size ?? row.size);
          if (busId !== undefined && (source.busId === undefined || busId === source.busId) && integer(row.uploader) === source.uploader &&
              size === source.size && (row.parent_folder_id === undefined || row.parent_folder_id === folder)) return { busId };
        }
        return;
      }
      for (const row of page.folders) {
        const child = record(row) && integer(row.group_id) === group &&
          (protocol === "onebot" ? row.parent_folder_id === undefined || row.parent_folder_id === folder : row.parent_folder_id === folder) &&
          opaqueId(row.folder_id);
        if (!child || seen.has(child)) continue;
        if (folders.length >= 64) return;
        seen.add(child);
        folders.push(child);
      }
    }
  } catch {
    return;
  }
}
