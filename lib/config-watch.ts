export function watchConfigFiles(signal: AbortSignal, reload: () => Promise<void>, reportFailure: () => void) {
  if (signal.aborted) return;
  let running = false;
  let failed = false;
  async function refresh() {
    if (running || signal.aborted) return;
    running = true;
    try {
      await reload();
      failed = false;
    } catch {
      if (!failed && !signal.aborted) reportFailure();
      failed = true;
    } finally {
      running = false;
    }
  }
  // Read the effective contents so same-size rewrites with unchanged timestamps still take effect.
  const timer = setInterval(() => { void refresh(); }, 1_000).unref();
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  void refresh();
}
