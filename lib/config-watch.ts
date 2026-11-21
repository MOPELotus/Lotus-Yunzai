import { watchFile, unwatchFile } from "node:fs";

export function watchConfigFiles(root: URL, name: "bot" | "group" | "other", signal: AbortSignal, reload: () => Promise<void>, reportFailure: () => void) {
  if (signal.aborted) return;
  const paths = [`config/${name}.yaml`, `config/config/${name}.yaml`].map(path => new URL(path, root));
  let dirty = false;
  let running = false;
  let failed = false;
  async function changed() {
    dirty = true;
    if (running) return;
    running = true;
    while (dirty && !signal.aborted) {
      dirty = false;
      try {
        await reload();
        failed = false;
      } catch {
        if (!failed && !signal.aborted) reportFailure();
        failed = true;
      }
    }
    running = false;
  }
  for (const path of paths) watchFile(path, { interval: 1_000, persistent: false }, changed);
  signal.addEventListener("abort", () => {
    for (const path of paths) unwatchFile(path, changed);
  }, { once: true });
  // Catch edits made between the initial read and watcher registration.
  void changed();
}
