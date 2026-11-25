import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { readLegacyPanelRecoveryEnabled } from "./legacy-panel-recovery-flow.ts";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, parseDocument } from "yaml";
import { GlobalConfigWriteError, updateLocalConfiguration, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { isTrialTitleMode, readPanelTrialDisplay } from "./panel-trial-display.ts";
import { readPanelJson } from "./panel.ts";
import { readLegacyCharacterAliasMode, validLegacyCharacterAliasMode } from "./game-character-aliases.ts";

type Config = Readonly<Record<string, unknown>>;
type Primitive = boolean | string | number;
type Section = "showcase" | "genshin-damage";
type SettingField = {
  readonly key: string;
  readonly label: string;
  readonly type: "boolean" | "number" | "text" | "select";
  readonly options?: readonly { readonly label: string; readonly value: Primitive }[];
  readonly min?: number;
  readonly max?: number;
  readonly hint?: string;
  readonly readonly?: boolean;
};
type Edit = { readonly path: readonly [string] | readonly [string, string]; readonly value: Primitive | readonly string[] };
class InvalidGameSettings extends Error {}

function object(value: unknown): Config | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Config : undefined;
}

function editYaml(content: string, local: Config, edits: readonly Edit[]) {
  const document = parseDocument(content, { strict: true, uniqueKeys: true, merge: true });
  if (document.errors.length || (document.contents && !isMap(document.contents))) throw new GlobalConfigWriteError("config");
  const expected = { ...local };
  for (const { path: [section, key], value } of edits) {
    if (!key) {
      document.set(section, value);
      expected[section] = value;
      continue;
    }
    const original = expected[section] === undefined ? {} : object(expected[section]);
    if (!original) throw new GlobalConfigWriteError("config");
    const node = document.get(section, true);
    if (isAlias(node)) {
      const shared = node.clone();
      shared.commentBefore = undefined;
      shared.spaceBefore = undefined;
      const overlay = document.createNode({ "<<": shared, [key]: value });
      overlay.commentBefore = node.commentBefore;
      overlay.spaceBefore = node.spaceBefore;
      document.set(section, overlay);
    } else {
      if (node !== undefined && !isMap(node)) throw new GlobalConfigWriteError("config");
      document.setIn([section, key], value);
    }
    expected[section] = { ...original, [key]: value };
  }
  const yaml = document.toString({ lineWidth: 0 });
  if (!isDeepStrictEqual(Bun.YAML.parse(yaml), expected)) throw new GlobalConfigWriteError("config");
  return yaml;
}

const starRailShowcaseOverride = () => !!Bun.env.LOTUS_STAR_RAIL_SHOWCASE_SERVER?.trim();
const validPublicShowcaseSelector = (value: unknown): value is string => typeof value === "string" && /^[0234]{1,3}$/u.test(value);

export async function saveStarRailShowcaseServer(root: URL, value: string, signal: AbortSignal, authorized: () => boolean) {
  const { readShowcaseServer } = await import("../plugins/starrail/panel-showcase-config.ts");
  return updateLotusGlobalConfig(root, {
    signal,
    canWrite: authorized,
    canCommit: () => authorized() && !starRailShowcaseOverride(),
    resolveEffective: async () => ({ starrailSource: await readShowcaseServer(root) }),
    prepare(content, local, effective) {
      if (starRailShowcaseOverride() || !validPublicShowcaseSelector(value)) throw new InvalidGameSettings();
      return { value, yaml: effective.starrailSource === value ? undefined :
        editYaml(content, local, [{ path: ["starrail", "showcase_server"], value }]) };
    },
  });
}

async function showcasePanel(root: URL) {
  const [{ readGenshinShowcaseServer }, { readShowcaseServer }, { readGridFightRecentCount }, originals] = await Promise.all([
    import("../plugins/genshin/panel/showcase-config.ts"),
    import("../plugins/starrail/panel-showcase-config.ts"),
    import("../plugins/starrail/grid-fight-config.ts"),
    import("../plugins/starrail/panel-original-config.ts"),
  ]);
  const fields: readonly SettingField[] = [
    { key: "panelTrialDifference", label: $t("lib.panel-game-settings.text_d8ed2c7c59"), type: "boolean",
      hint: $t("lib.panel-game-settings.text_8c87777f47") },
    { key: "panelTrialLongTitle", label: $t("lib.panel-game-settings.text_3a8d4109ba"), type: "select",
      options: [{ label: $t("lib.panel-game-settings.text_670ec25af8"), value: 0 }, { label: $t("lib.panel-game-settings.text_dc26ee3912"), value: 1 }, { label: $t("lib.panel-game-settings.text_bd609a8e2d"), value: 2 }] },
    { key: "legacyPanelRecovery", label: $t("lib.panel-game-settings.text_bb255c8225"), type: "boolean",
      hint: $t("lib.panel-game-settings.text_900f6a2c95") },
    {
      key: "genshinSource", label: $t("lib.panel-game-settings.text_02c5377c45"), type: "text",
      readonly: !!Bun.env.LOTUS_GENSHIN_SHOWCASE_SERVER?.trim(),
      hint: $t("lib.panel-game-settings.text_3462740839"),
    },
    {
      key: "starrailSource", label: $t("lib.panel-game-settings.text_7cd54f02ec"), type: "text",
      readonly: starRailShowcaseOverride(),
      hint: $t("lib.panel-game-settings.text_2a02d62820"),
    },
    {
      key: "gridFightRecentCount", label: $t("lib.panel-game-settings.text_b2b5a9c104"), type: "number", min: 1, max: 3,
      hint: $t("lib.panel-game-settings.text_d3467386c0"),
    },
    {
      key: "starrailLegacyAliasMode", label: $t("lib.panel-game-settings.text_e16c7c8fc0"), type: "select",
      hint: $t("lib.panel-game-settings.text_af72e9f616"),
      options: [
        { label: $t("lib.panel-game-settings.text_dc138aeaa5"), value: 2 },
        { label: $t("lib.panel-game-settings.text_e773cfdb25"), value: 1 },
        { label: $t("lib.panel-game-settings.text_abb17b4835"), value: 0 },
      ],
    },
    { key: "starrailBuiltInPortraitGroups", label: $t("lib.panel-game-settings.text_006040c943"), type: "text",
      hint: $t("lib.panel-game-settings.text_20d7d5f853") },
    { key: "starrailOriginalEnabled", label: $t("lib.panel-game-settings.text_1527b86f5c"), type: "boolean", hint: $t("lib.panel-game-settings.text_326d2bed77") },
    { key: "starrailOriginalRecall", label: $t("lib.panel-game-settings.text_f98e4f15c7"), type: "boolean" },
    {
      key: "starrailOriginalRecallSeconds", label: $t("lib.panel-game-settings.text_ca33ef5e91"), type: "number", min: 0,
      max: originals.maxStarRailOriginalRecallSeconds, hint: $t("lib.panel-game-settings.text_eb1fb987c9"),
    },
  ];
  async function read() {
    const [genshinSource, starrailSource, gridFightRecentCount, originalSettings, legacyPanelRecovery,
      portraitGroups, starrailLegacyAliasMode, trial] = await Promise.all([
      readGenshinShowcaseServer(root), readShowcaseServer(root), readGridFightRecentCount(root), originals.readStarRailOriginalSettings(root),
      readLegacyPanelRecoveryEnabled(root), originals.readStarRailBuiltInPortraitGroups(root),
      readLegacyCharacterAliasMode("sr", fileURLToPath(root)).catch(() => 2), readPanelTrialDisplay(root),
    ]);
    return { genshinSource, starrailSource, gridFightRecentCount, ...originalSettings, legacyPanelRecovery, starrailLegacyAliasMode,
      starrailBuiltInPortraitGroups: portraitGroups.join(", "),
      panelTrialDifference: trial.showDifference, panelTrialLongTitle: trial.longTitle };
  }
  return {
    fields,
    read,
    save(previous: Config, values: Config, signal: AbortSignal, authorized: () => boolean) {
      return updateLotusGlobalConfig(root, {
        signal, canWrite: authorized, canCommit: authorized, resolveEffective: read,
        prepare(content, local, effective) {
          const current = effective as Awaited<ReturnType<typeof read>>;
          if (!isDeepStrictEqual(current, previous)) throw new GlobalConfigWriteError("conflict");
          const edits: Edit[] = [];
          if (typeof values.panelTrialDifference !== "boolean" || !isTrialTitleMode(values.panelTrialLongTitle)) throw new InvalidGameSettings();
          if (values.panelTrialDifference !== current.panelTrialDifference) {
            edits.push({ path: ["panel_trial", "show_difference"], value: values.panelTrialDifference });
          }
          if (values.panelTrialLongTitle !== current.panelTrialLongTitle) {
            edits.push({ path: ["panel_trial", "long_title"], value: values.panelTrialLongTitle });
          }
          if (typeof values.legacyPanelRecovery !== "boolean") throw new InvalidGameSettings();
          if (values.legacyPanelRecovery !== current.legacyPanelRecovery) {
            edits.push({ path: ["panel_legacy_recovery"], value: values.legacyPanelRecovery });
          }
          for (const [field, section, override] of [
            ["genshinSource", "genshin", "LOTUS_GENSHIN_SHOWCASE_SERVER"],
            ["starrailSource", "starrail", "LOTUS_STAR_RAIL_SHOWCASE_SERVER"],
          ] as const) {
            const value = values[field];
            if (value === current[field]) continue;
            if (Bun.env[override]?.trim() || !validPublicShowcaseSelector(value) ||
                (section === "genshin" && (value[2] ?? value[0]) === "3")) throw new InvalidGameSettings();
            edits.push({ path: [section, "showcase_server"], value });
          }
          const recent = values.gridFightRecentCount;
          if (recent !== 1 && recent !== 2 && recent !== 3) throw new InvalidGameSettings();
          if (recent !== current.gridFightRecentCount) edits.push({ path: ["starrail", "grid_fight_recent_count"], value: recent });
          const aliasMode = values.starrailLegacyAliasMode;
          if (!validLegacyCharacterAliasMode(aliasMode)) throw new InvalidGameSettings();
          if (aliasMode !== current.starrailLegacyAliasMode) edits.push({ path: ["starrail", "legacy_alias_group_permission"], value: aliasMode });
          for (const [field, key] of [
            ["starrailOriginalEnabled", "original_pic"], ["starrailOriginalRecall", "back_call_original_pic"],
          ] as const) {
            const value = values[field];
            if (typeof value !== "boolean") throw new InvalidGameSettings();
            if (value !== current[field]) edits.push({ path: ["starrail", key], value });
          }
          const requestedGroups = values.starrailBuiltInPortraitGroups;
          if (requestedGroups !== current.starrailBuiltInPortraitGroups) {
            const groups = originals.parseStarRailPortraitGroups(requestedGroups);
            if (!groups) throw new InvalidGameSettings();
            edits.push({ path: ["starrail", "built_in_portrait_groups"], value: groups });
          }
          const seconds = values.starrailOriginalRecallSeconds;
          if (!originals.validStarRailOriginalRecallSeconds(seconds)) throw new InvalidGameSettings();
          if (seconds !== current.starrailOriginalRecallSeconds) edits.push({ path: ["starrail", "back_call_original_pic_time"], value: seconds });
          return { value: values, yaml: edits.length ? editYaml(content, local, edits) : undefined };
        },
      });
    },
  };
}

async function damagePanel(root: URL) {
  const { damageConfigOverride, resolveDamageSettings } = await import("../plugins/genshin/panel/lolomi/config.ts");
  const hint = $t("lib.panel-game-settings.text_d3d0842647");
  const fields: readonly SettingField[] = [
    { key: "lolomicalc", label: $t("lib.panel-game-settings.text_d35991fc32"), type: "boolean", hint },
    { key: "lolomiartis", label: $t("lib.panel-game-settings.text_711780249d"), type: "boolean", hint },
    { key: "templateteam", label: $t("lib.panel-game-settings.text_8ca272d31c"), type: "boolean", hint },
    { key: "conscompare", label: $t("lib.panel-game-settings.text_b7bcacf5dc"), type: "boolean", hint },
    {
      key: "engineMode", label: $t("lib.panel-game-settings.text_fa3427bb14"), type: "select", hint,
      options: [
        { label: $t("lib.panel-game-settings.text_7eb336e42c"), value: "auto" },
        { label: "Lolomi", value: "lolomi" },
        { label: $t("lib.panel-game-settings.text_127c8f8849"), value: "miao" },
      ],
    },
  ];
  async function read() {
    const file = Bun.file(damageConfigOverride || new URL("config/genshin-damage.yaml", root));
    const config = await file.exists() ? Bun.YAML.parse(await file.text()) : undefined;
    return resolveDamageSettings(config ?? {});
  }
  return {
    fields,
    read,
    save(previous: Config, values: Config, signal: AbortSignal, authorized: () => boolean) {
      return updateLocalConfiguration(root, "genshin-damage", {
        override: damageConfigOverride, signal, canWrite: authorized, canCommit: authorized,
        prepare(content, local) {
          const current = resolveDamageSettings(local);
          if (!isDeepStrictEqual(current, previous)) throw new GlobalConfigWriteError("conflict");
          let next: ReturnType<typeof resolveDamageSettings>;
          try { next = resolveDamageSettings(values); }
          catch { throw new InvalidGameSettings(); }
          if (!isDeepStrictEqual(next, values)) throw new InvalidGameSettings();
          const edits: Edit[] = fields.flatMap(({ key }) => {
            const typedKey = key as keyof typeof next;
            return current[typedKey] === next[typedKey] ? [] : [{ path: [key], value: next[typedKey] }];
          });
          return { value: next, yaml: edits.length ? editYaml(content, local, edits) : undefined };
        },
      });
    },
  };
}

export function panelGameSettings(root: URL, section: Section) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    try {
      const settings = await (section === "showcase" ? showcasePanel(root) : damagePanel(root));
      const fields = settings.fields.map(field => field.readonly
        ? { ...field, hint: $t("lib.panel-game-settings.text_8f94d2cb93", { "hint": field.hint }) }
        : field);
      if (request.method === "GET") {
        const values = await settings.read();
        return active() ? Response.json({ fields, values }) : new Response(null, { status: 401 });
      }
      let body: Config | undefined;
      try { body = object(await readPanelJson(request, 4096)); }
      catch { throw new InvalidGameSettings(); }
      const previous = object(body?.previous), values = object(body?.values);
      if (!body || Object.keys(body).length !== 2 || !previous || !values || Object.keys(values).length !== fields.length ||
          !fields.every(field => Object.hasOwn(values, field.key))) throw new InvalidGameSettings();
      const saved = await settings.save(previous, values, request.signal, active);
      return Response.json({ fields, values: saved });
    } catch (error) {
      if (!active() || error instanceof GlobalConfigWriteError && (error.reason === "permission" || error.reason === "cancelled")) {
        return new Response(null, { status: 401 });
      }
      if (error instanceof InvalidGameSettings) return new Response(null, { status: 400 });
      return new Response(null, { status: error instanceof GlobalConfigWriteError && error.reason === "conflict" ? 409 : 500 });
    }
  };
}
