import { pathToFileURL } from "node:url";
import { ensureLegacyValkey, prepareLegacyValkeyHandoff, publishLegacyValkeyHandoff, quiesceLegacyValkeyHandoff, resumeLegacyValkeyHandoff, stopLegacyValkey } from "../lib/legacy-valkey-handoff.ts";
import { readStorageConnection } from "../lib/valkey-config.ts";

const [action, ...args] = process.argv.slice(2);
try {
  let result: unknown;
  if (action === "prepare") {
    const [source, target, pid, planDirectory, dedicatedCgroup] = args;
    if (!source || !target || !pid || !planDirectory || !/^[1-9]\d*$/u.test(pid)) throw Error("legacy_valkey_arguments");
    result = await prepareLegacyValkeyHandoff({ source, target, oldPid: Number(pid), planDirectory, dedicatedCgroup });
  } else if (action === "publish" || action === "quiesce" || action === "resume") {
    if (!args[0]) throw Error("legacy_valkey_arguments");
    result = action === "publish" ? await publishLegacyValkeyHandoff(args[0]) : action === "quiesce" ? await quiesceLegacyValkeyHandoff(args[0]) : await resumeLegacyValkeyHandoff(args[0]);
  } else if (action === "start" || action === "stop") {
    if (!args[0]) throw Error("legacy_valkey_arguments");
    const root = pathToFileURL(args[0].replace(/\/$/u, "") + "/");
    const managed = action === "stop" ? await stopLegacyValkey(root) : await ensureLegacyValkey(root, await readStorageConnection(root));
    result = { status: managed ? action === "stop" ? "stopped" : "started" : "external" };
  } else throw Error("legacy_valkey_arguments");
  console.log(JSON.stringify(result));
} catch {
  // Never serialize Redis errors, endpoints, credentials, ACL lines, or CONFIG values.
  console.error("legacy_valkey_handoff_failed");
  process.exitCode = 1;
}
