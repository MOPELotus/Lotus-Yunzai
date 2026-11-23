import { expect, test } from "bun:test";
import { characterGalleryCron, createCharacterGallerySchedule } from "../lib/character-gallery-schedule.ts";

test("角色图库每天检查两次，启动前可撤销，读取独立的图库开关", async () => {
  let config = { atlas: { sync_gallery: false, sync_character_gallery: false } };
  const completed: { downloaded: number; reused: number; removed: number }[] = [];
  const aborted = new AbortController();
  const schedule = createCharacterGallerySchedule({
    readConfig: async () => config,
    async synchronize(signal) {
      expect(signal.aborted).toBe(false);
      return { downloaded: 4, reused: 8, removed: 1 };
    },
    report: summary => completed.push(summary),
    reportFailure: error => { throw error; },
  });

  expect(characterGalleryCron).toBe("0 0 */12 * * *");
  await schedule.run(new AbortController().signal);
  expect(completed).toEqual([]);

  config = { atlas: { sync_gallery: false, sync_character_gallery: true } };
  const startup = schedule.startup(aborted.signal, 100);
  aborted.abort();
  await startup;
  expect(completed).toEqual([]);

  await schedule.startup(new AbortController().signal, 0);
  expect(completed).toEqual([{ downloaded: 4, reused: 8, removed: 1 }]);
});

test("角色图库避免重复同步，失败结束后可重新检查", async () => {
  const signal = new AbortController().signal;
  const reached = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<never>();
  const warnings: unknown[] = [];
  let calls = 0;
  const schedule = createCharacterGallerySchedule({
    readConfig: async () => ({}),
    async synchronize() {
      calls++;
      if (calls === 1) {
        reached.resolve();
        return blocked.promise;
      }
      return { downloaded: 0, reused: 3, removed: 0 };
    },
    report: () => { throw new Error("无改动时不重复公告"); },
    reportFailure: error => warnings.push(error),
  });
  const sync = schedule.run(signal);
  await reached.promise;
  await schedule.run(signal);
  expect(calls).toBe(1);
  blocked.reject(new Error("无法连接图库"));
  await sync;
  expect(warnings).toEqual([new Error("无法连接图库")]);
  await schedule.run(signal);
  expect(calls).toBe(2);
});
