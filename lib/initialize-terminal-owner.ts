import { isMap, parseDocument } from "yaml";
import { updateLocalConfiguration, GlobalConfigWriteError } from "./lotus-global-config-write.ts";

/** A new local installation grants stdin only. Explicit existing owner lists are preserved. */
export async function initializeTerminalOwner(root: URL, signal: AbortSignal): Promise<boolean> {
  return updateLocalConfiguration(root, "other", {
    signal, canWrite: () => !signal.aborted,
    prepare(content, _local, effective) {
      if (Object.hasOwn(effective, "master")) return { value: false };
      const document = parseDocument(content, { strict: true, uniqueKeys: true, merge: true });
      if (document.errors.length || document.contents && !isMap(document.contents)) throw new GlobalConfigWriteError("config");
      document.set("master", ["stdin:stdin"]);
      return { yaml: document.toString({ lineWidth: 0 }), value: true };
    },
  });
}
