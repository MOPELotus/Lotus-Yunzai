import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isMap, parseDocument } from "yaml";
import { GlobalConfigWriteError, updateLocalConfiguration, withLocalGroupConfigWrite } from "./lotus-global-config-write.ts";
import { readGroupLikeSettingsModule } from "./panel-group.ts";
import type { PluginLoadReport } from "./plugins/loader.ts";
import type { MessageReply } from "./messages.ts";
import type { NoticeSettingsCardGroup, NoticeSettingsCardRenderer } from "../plugins/group/notice-settings-card-model.ts";

type Setting =
  | { setting: "陌生人点赞" | "状态"; enabled: boolean }
  | { setting: "渲染精度" | "设置"; enabled?: never };

export function chatSetting(message: string): Setting | undefined {
  if (message === "#设置") return { setting: "设置" };
  const change = /^#设置(陌生人点赞|状态)\s*(开启|关闭)$/u.exec(message);
  if (change) return { setting: change[1] === "状态" ? "状态" : "陌生人点赞", enabled: change[2] === "开启" };
  if (/^#设置渲染精度\s*\d+秒?$/u.test(message)) return { setting: "渲染精度" };
}

async function readDefaultStatus(directories: PluginLoadReport["directories"]) {
  const system = directories.get("system");
  if (system?.packageName !== "@lotus-yunzai/system") return;
  const module = await import(pathToFileURL(join(system.path, "status-background.ts")).href) as
    typeof import("../plugins/system/status-background.ts");
  const config = await module.readStatusConfig();
  if (config) return config.defaultState === true;
}

function saveDefaultStatus(root: URL, enabled: boolean, canWrite: () => boolean, signal: AbortSignal) {
  return updateLocalConfiguration(root, "system-status", {
    canWrite, signal, override: Bun.env.LOTUS_SYSTEM_STATUS_CONFIG,
    prepare(text, current) {
      if (Buffer.byteLength(text) > 64 * 1024) throw new GlobalConfigWriteError("config");
      const document = parseDocument(text, { strict: true, uniqueKeys: true });
      if (document.errors.length || (document.contents && !isMap(document.contents))) throw new GlobalConfigWriteError("config");
      if (current.defaultState === enabled) return { value: enabled };
      document.set("defaultState", enabled);
      const yaml = document.toString({ lineWidth: 0 });
      if (Buffer.byteLength(yaml) > 64 * 1024 || !isDeepStrictEqual(Bun.YAML.parse(yaml), { ...current, defaultState: enabled })) {
        throw new GlobalConfigWriteError("config");
      }
      return { yaml, value: enabled };
    },
  });
}

const enabledLabel = (enabled: boolean | undefined) => enabled === undefined ? $t("lib.chat-settings.text_c270415855") : enabled ? $t("lib.chat-settings.text_8a4ef3e48e") : $t("lib.chat-settings.text_6744b4c6a9");

function cardGroups(like: boolean | undefined, status: boolean | undefined): NoticeSettingsCardGroup[] {
  return [{
    title: $t("lib.chat-settings.text_68ea5dd4d7"),
    rows: [
      {
        label: $t("lib.chat-settings.text_9da9735f47"), value: enabledLabel(like), off: like !== true, hint: $t("lib.chat-settings.text_3d80ac3b4c"),
        description: $t("lib.chat-settings.text_2faaa89b4e"),
      },
      {
        label: $t("lib.chat-settings.text_0710358f06"), value: enabledLabel(status), off: status !== true, hint: $t("lib.chat-settings.text_1ca5257247"),
        description: $t("lib.chat-settings.text_82911d96fe"),
      },
    ],
  }, {
    title: $t("lib.chat-settings.text_863edfe5ac"), rows: [
      { label: $t("lib.chat-settings.text_247ca01ae2"), hint: "#通知设置", value: ">>>", description: $t("lib.chat-settings.text_c3a6f9ffaf") },
    ],
  }];
}

export function createChatSettings(root: URL, directories: PluginLoadReport["directories"]) {
  const likes = () => readGroupLikeSettingsModule(directories);
  let renderCard: Promise<NoticeSettingsCardRenderer> | undefined;
  function loadRenderer(groupPath: string) {
    const override = Bun.env.LOTUS_GROUP_NOTICE_THEME_DIR?.trim();
    const resourceDirectories = override ? [override] : ["data/group/notice-theme/", "plugins/yenai-plugin/resources/"]
      .map(directory => fileURLToPath(new URL(directory, root)));
    return import(pathToFileURL(join(groupPath, "notice-settings-card-renderer.ts")).href).then(
      ({ createAdminSettingsCardRenderer }: typeof import("../plugins/group/notice-settings-card-renderer.ts")) =>
        createAdminSettingsCardRenderer({ resourceDirectories, label: "#设置" }),
    );
  }
  return async ({ setting, enabled }: Setting, canWrite: () => boolean, signal: AbortSignal,
    withImage = true): Promise<MessageReply | undefined> => {
    if (!canWrite()) return $t("lib.chat-settings.text_bc401012d5");
    if (setting === "渲染精度") return $t("lib.chat-settings.text_3225f47f7f");
    if (setting === "状态") {
      if (directories.get("system")?.packageName !== "@lotus-yunzai/system") return $t("lib.chat-settings.text_5c36454321");
      try {
        await saveDefaultStatus(root, enabled, canWrite, signal);
      } catch {
        return $t("lib.chat-settings.text_cac4432cff");
      }
    } else if (setting === "陌生人点赞") {
      try {
        const service = await likes();
        if (!service) return $t("lib.chat-settings.text_d2b0df742a");
        for (let attempt = 0; ; attempt++) {
          const { revision } = await service.readLikeSettings();
          try {
            await withLocalGroupConfigWrite(root, () => service.saveLikeSettings({ strangeThumbUp: enabled }, { revision, canWrite }));
            break;
          } catch (cause) {
            if (!canWrite() || attempt >= 2 || !(cause instanceof service.LikeSettingsError) || cause.code !== "conflict") throw cause;
          }
        }
      } catch {
        return $t("lib.chat-settings.text_a4edd615f5");
      }
    }
    const [like, status] = await Promise.all([
      likes().then(async (service) => (await service?.readLikeSettings())?.settings.strangeThumbUp).catch(() => undefined),
      readDefaultStatus(directories).catch(() => undefined),
    ]);
    if (signal.aborted || !canWrite()) return;
    const group = directories.get("group");
    const notices = group?.packageName === "@lotus-yunzai/group";
    if (withImage && notices) {
      try {
        renderCard ??= loadRenderer(group.path);
        const file = await (await renderCard)({ groups: cardGroups(like, status) }, signal);
        if (signal.aborted || !canWrite()) return;
        if (file?.byteLength) return { type: "image", file };
      } catch {
        if (signal.aborted || !canWrite()) return;
      }
    }
    return [
      $t("lib.chat-settings.text_8bd9de142b"),
      $t("lib.chat-settings.text_524a1801aa", { "value1": enabledLabel(like) }),
      $t("lib.chat-settings.text_4e7df59721"),
      $t("lib.chat-settings.text_486e093912", { "value1": enabledLabel(status) }),
      $t("lib.chat-settings.text_dc855b011d"),
      ...(notices ? [$t("lib.chat-settings.text_5314f25257")] : []),
    ].join("\n");
  };
}
