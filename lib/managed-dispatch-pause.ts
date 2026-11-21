import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export const managedDispatchPauseFile = "host-dispatch-pause";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

export function managedDispatchPause(path: string, attempt: string) {
  if (!uuid.test(attempt)) throw new Error("后台软关机状态的启动标记无效。");
  return {
    load(): number | null | undefined {
      let contents: string;
      try {
        contents = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new Error("无法读取后台软关机状态。", { cause: error });
      }
      try {
        const { attempt: recorded, pausedAt } = JSON.parse(contents) as { attempt: unknown; pausedAt: unknown };
        if (typeof recorded !== "string" || !uuid.test(recorded)) throw new Error("启动标记无效。");
        if (recorded !== attempt) return;
        if (pausedAt === null) return null;
        if (typeof pausedAt !== "number" || !Number.isSafeInteger(pausedAt) || pausedAt <= 0) {
          throw new Error("关机时间无效。");
        }
        return pausedAt;
      } catch (error) {
        throw new Error("无法核实后台软关机状态。", { cause: error });
      }
    },
    save(pausedAt?: number) {
      const temporary = `${path}.${crypto.randomUUID()}`;
      try {
        writeFileSync(temporary, JSON.stringify({ attempt, pausedAt: pausedAt ?? null }), { mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
      } catch (error) {
        try { rmSync(temporary, { force: true }); } catch {}
        throw new Error("无法保存后台软关机状态。", { cause: error });
      }
    },
  };
}
