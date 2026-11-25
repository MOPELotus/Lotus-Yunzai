import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import type { MessageEvent } from "./messages.ts";
import { canManagePackages } from "./command-permissions.ts";

export type InstallProgress = "checking" | "building" | "switching" | "busy" | "exists" | "unavailable" | "rejected" | "storage-changed" | "failed";

interface InstallCallbacks {
  list(event: MessageEvent): readonly string[] | Promise<readonly string[]>;
  install(event: MessageEvent, shortName: string, report: (status: InstallProgress) => void): boolean | Promise<boolean>;
}

const command = "#安装";
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
const shortName = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const suffix = /-[Pp]lugin$/u;
const replies: Readonly<Record<InstallProgress, string>> = {
  checking: $t("lib.install-command.text_2ac36b053b"),
  building: $t("lib.install-command.text_734b0a5168"),
  switching: $t("lib.install-command.text_2318ab0853"),
  busy: $t("lib.install-command.text_a90cda2154"),
  exists: $t("lib.install-command.text_5b1b96ed7f"),
  unavailable: $t("lib.install-command.text_3b5964a868"),
  rejected: $t("lib.install-command.text_d2bb72d2c7"),
  "storage-changed": $t("lib.install-command.text_642562fa39"),
  failed: $t("lib.install-command.text_5f7a9cfb7f"),
};

export function isInstallName(name: unknown): name is string {
  return typeof name === "string" && shortName.test(name) && !name.includes("..");
}

export function parseInstallName(argument: string): string | undefined {
  if (controls.test(argument)) return;
  const name = argument.trim().replace(suffix, "");
  if (!isInstallName(name)) return;
  return name;
}

export function isInstallCommand(message: string): boolean {
  return message.trimStart().startsWith(command);
}

export function hasValidInstallTarget(text: string): boolean {
  const message = text.trimStart();
  return message.startsWith(command) && parseInstallName(message.slice(command.length)) !== undefined;
}

export function createInstallCommand(callbacks: InstallCallbacks) {
  return async (event: MessageEvent): Promise<void> => {
    const message = event.msg.trimStart();
    if (!message.startsWith(command)) return;
    if (!canManagePackages(event)) {
      await event.reply($t("lib.install-command.text_ee7b348d1b"));
      return;
    }

    const name = parseInstallName(message.slice(command.length));
    if (!name) {
      await event.reply($t("lib.install-command.text_b0139d7788"));
      return;
    }
    if (name === "插件") {
      let names: readonly string[];
      try {
        const listed = await callbacks.list(event);
        names = [...new Set(listed.filter((label) => {
          const parsed = parseInstallName(label);
          return parsed !== undefined && parsed !== "插件" && label.trim() === label;
        }))];
      } catch {
        await event.reply($t("lib.install-command.text_8c47777101"));
        return;
      }
      await event.reply(names.length
        ? [$t("lib.install-command.text_3caf6da31c"), ...names, $t("lib.install-command.text_9d7b70483a")].join("\n")
        : $t("lib.install-command.text_d6853b0c3e"));
      return;
    }

    let pending = Promise.resolve();
    const report = (status: InstallProgress) => {
      pending = pending.then(async () => { await event.reply(replies[status]); }).catch(() => undefined);
    };
    let sent: boolean;
    try {
      sent = await callbacks.install(event, name, report);
    } catch {
      await event.reply($t("lib.install-command.text_86310754ea"));
      return;
    }
    if (!sent) {
      await event.reply($t("lib.install-command.text_548e4416ec"));
      return;
    }
    await pending;
  };
}
