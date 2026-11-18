import { createManagedSupervisor } from "../lib/managed-supervisor.ts";

if (import.meta.main) {
  const supervisor = createManagedSupervisor(process.argv[2] ?? process.cwd());
  const interrupt = () => { void supervisor.stop("SIGINT"); };
  const terminate = () => { void supervisor.stop("SIGTERM"); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    await supervisor.start();
    process.exitCode = await supervisor.done;
  } catch {
    console.error("托管宿主无法启动。");
    process.exitCode = await supervisor.done;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
