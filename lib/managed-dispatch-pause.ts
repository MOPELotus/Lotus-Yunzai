import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export const managedDispatchPauseFile = "host-dispatch-pause";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

export function managedDispatchPause(path: string, attempt: string) {
  if (!uuid.test(attempt)) throw new Error($t("lib.managed-dispatch-pause.text_e855668ae8"));
  return {
    load(): number | null | undefined {
      let contents: string;
      try {
        contents = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new Error($t("lib.managed-dispatch-pause.text_2095a75e66"), { cause: error });
      }
      try {
        const { attempt: recorded, pausedAt } = JSON.parse(contents) as { attempt: unknown; pausedAt: unknown };
        if (typeof recorded !== "string" || !uuid.test(recorded)) throw new Error($t("lib.managed-dispatch-pause.text_45e98bb631"));
        if (recorded !== attempt) return;
        if (pausedAt === null) return null;
        if (typeof pausedAt !== "number" || !Number.isSafeInteger(pausedAt) || pausedAt <= 0) {
          throw new Error($t("lib.managed-dispatch-pause.text_463e35249d"));
        }
        return pausedAt;
      } catch (error) {
        throw new Error($t("lib.managed-dispatch-pause.text_6c8fee6eeb"), { cause: error });
      }
    },
    save(pausedAt?: number) {
      const temporary = `${path}.${crypto.randomUUID()}`;
      try {
        writeFileSync(temporary, JSON.stringify({ attempt, pausedAt: pausedAt ?? null }), { mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
      } catch (error) {
        try { rmSync(temporary, { force: true }); } catch {}
        throw new Error($t("lib.managed-dispatch-pause.text_fcba8ebee1"), { cause: error });
      }
    },
  };
}
