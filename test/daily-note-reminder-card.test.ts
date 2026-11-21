import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDailyNoteReminderCard } from "../packages/skia/daily-note-reminder-card.ts";

test("群体力卡没有明确的本地原素材时退回文字", async () => {
  const model = { game: "gs", current: 160, max: 200 } as const;
  const directory = await mkdtemp(join(tmpdir(), "lotus-note-card-assets."));
  try {
    expect(await renderDailyNoteReminderCard(model)).toBeUndefined();
    expect(await renderDailyNoteReminderCard(model, { resourceDirectory: directory })).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true });
  }
});
