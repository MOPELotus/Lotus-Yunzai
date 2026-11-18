import { isManagedUpdateName } from "./managed-update-protocol.ts";

const controls = /[\u0000-\u001f\u007f-\u009f]/u;

export function parseUpdateTarget(argument: string): string | undefined {
  const requested = argument.trim();
  if (controls.test(argument) || (requested && !isManagedUpdateName(requested))) return;
  return requested;
}
