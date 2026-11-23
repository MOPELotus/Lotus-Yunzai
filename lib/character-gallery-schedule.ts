import { setTimeout as sleep } from "node:timers/promises";

export const characterGalleryCron = "0 0 */12 * * *";
const firstSyncDelay = 60_000;

type GallerySyncSummary = Readonly<{
  downloaded: number;
  reused: number;
  removed: number;
}>;

export function createCharacterGallerySchedule(options: {
  readonly readConfig: () => Promise<Readonly<Record<string, unknown>>>;
  readonly synchronize: (signal: AbortSignal) => Promise<GallerySyncSummary>;
  readonly report: (summary: GallerySyncSummary) => void;
  readonly reportFailure: (error: unknown) => void;
}) {
  let syncing = false;

  async function run(signal: AbortSignal) {
    if (signal.aborted || syncing) return;
    syncing = true;
    try {
      const { atlas } = await options.readConfig();
      if (signal.aborted || (atlas && typeof atlas === "object" &&
          "sync_character_gallery" in atlas && atlas.sync_character_gallery === false)) return;
      const summary = await options.synchronize(signal);
      if (!signal.aborted && (summary.downloaded || summary.removed)) options.report(summary);
    } catch (error) {
      if (!signal.aborted) options.reportFailure(error);
    } finally {
      syncing = false;
    }
  }

  async function startup(signal: AbortSignal, delay = firstSyncDelay) {
    try {
      await sleep(delay, undefined, { signal, ref: false });
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    await run(signal);
  }

  return { run, startup };
}
