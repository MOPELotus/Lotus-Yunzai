import { isDeepStrictEqual } from "node:util";
import { isMap, parseDocument } from "yaml";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import { maxZzzRecallSeconds, readZzzRecallSeconds } from "./zzz-recall-config.ts";
import type { readRankGroupSwitch } from "../plugins/zzz/challenge-rank-store.ts";
import type { ChallengeReminderDefaults } from "../plugins/zzz/challenge-reminder-store.ts";

type Document = Readonly<Record<string, unknown>>;
type SwitchState = Awaited<ReturnType<typeof readRankGroupSwitch>>;
type RankValues = { allow_group: boolean; white_list: string[]; black_list: string[]; max_display: number };
type PanelValues = { roleInterval: number; recallMsg: number };

const rankFields = [
  { key: "allow_group", label: "绝区零群排行总开关", type: "boolean", hint: "开启时使用黑名单，关闭时只在白名单群开放。适用于挑战榜和角色面板榜。" },
  { key: "white_list", label: "群排行白名单", type: "list", hint: "每行一个群号。" },
  { key: "black_list", label: "群排行黑名单", type: "list", hint: "每行一个群号。" },
  { key: "max_display", label: "每页最多显示人数", type: "number", min: 1, max: 15 },
] as const;
const panelFields = [
  { key: "roleInterval", label: "逐角色请求间隔（毫秒）", type: "number", min: 0, max: 2_147_483_647,
    hint: "只控制一次更新中连续两个角色请求之间的间隔，最低按 100 毫秒执行。面板更新命令没有整次冷却。" },
  { key: "recallMsg", label: "提示撤回时间（秒）", type: "number", min: 0, max: maxZzzRecallSeconds,
    hint: "适用于绝区零临时提示和管理回执。填 0 可关闭自动撤回。" },
] as const;
const reminderFields = [
  { key: "enable", label: "挑战提醒总开关", type: "boolean", hint: "只向本人已订阅的好友私聊发送。" },
  { key: "abyssCheckLevel", label: "式舆检查关层", type: "number", min: 0, max: 6,
    hint: "0 关闭式舆提醒，6 检查第五层的 S+ 评级。" },
  { key: "deadlyStars", label: "危局星数阈值", type: "number", min: 0, max: 9, hint: "0 关闭危局提醒。" },
  { key: "remindTime", label: "默认提醒时间", type: "text",
    hint: "北京时间。可填每日20时或每周五20时30分，分钟须为整十分钟。" },
] as const;

function object(value: unknown): Document | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Document;
}

function groupList(value: unknown, legacy = false) {
  if (!Array.isArray(value) || value.length > 2000) throw new Error("无效的群排行名单");
  const ids = value.map(id => typeof id === "string" ? id :
    legacy && typeof id === "number" && Number.isSafeInteger(id) ? String(id) : "");
  if (!ids.every(id => /^[1-9]\d{0,15}$/u.test(id))) throw new Error("无效的群号");
  return [...new Set(ids)];
}

function readRankValues(document: Document, active: boolean | undefined): RankValues {
  const configured = document.allow_group ?? true, size = Number(document.max_display ?? 15);
  if ((typeof configured !== "boolean" && configured !== 0 && configured !== 1) || !Number.isInteger(size)) {
    throw new GlobalConfigWriteError("config");
  }
  return {
    allow_group: active ?? Boolean(configured),
    white_list: groupList(document.white_list ?? [], true),
    black_list: groupList(document.black_list ?? [], true),
    max_display: Math.max(1, Math.min(15, size)),
  };
}

function requestedRank(value: unknown): RankValues {
  const values = object(value);
  if (!values || Object.keys(values).length !== rankFields.length || typeof values.allow_group !== "boolean" ||
      typeof values.max_display !== "number" || !Number.isInteger(values.max_display) ||
      values.max_display < 1 || values.max_display > 15) throw new Error("无效的群排行设置");
  return { allow_group: values.allow_group, max_display: values.max_display,
    white_list: groupList(values.white_list), black_list: groupList(values.black_list) };
}

function requestedPanel(value: unknown): PanelValues {
  const values = object(value);
  if (!values || Object.keys(values).length !== panelFields.length) throw new Error("无效的面板刷新设置");
  const { roleInterval, recallMsg } = values;
  if (typeof roleInterval !== "number" || !Number.isSafeInteger(roleInterval) ||
      roleInterval < panelFields[0].min || roleInterval > panelFields[0].max) {
    throw new Error("无效的逐角色请求间隔");
  }
  if (typeof recallMsg !== "number" || !Number.isInteger(recallMsg) || recallMsg < 0 || recallMsg > maxZzzRecallSeconds) {
    throw new Error("无效的提示撤回时间");
  }
  return { roleInterval, recallMsg };
}

function edit(text: string, local: Document, changes: Document) {
  if (!Object.keys(changes).length) return;
  const document = parseDocument(text, { strict: true, uniqueKeys: true, merge: true });
  if (document.errors.length || (document.contents && !isMap(document.contents))) throw new GlobalConfigWriteError("config");
  for (const [key, value] of Object.entries(changes)) document.set(key, value);
  const yaml = document.toString({ lineWidth: 0 });
  if (!isDeepStrictEqual(Bun.YAML.parse(yaml), { ...local, ...changes })) throw new GlobalConfigWriteError("config");
  return yaml;
}

function fieldsChanged(before: RankValues, after: RankValues): Document {
  return Object.fromEntries(Object.entries(after).filter(([key, value]) =>
    !isDeepStrictEqual(value, before[key as keyof RankValues])));
}

async function readPanelSettings(root: URL, legacyResources = Bun.env.LOTUS_ZZZ_LEGACY_RESOURCES_DIR) {
  const { parseZzzPanelConfig, readZzzPanelConfigDocument, zzzPanelConfigFile } = await import("../plugins/zzz/panel-command.ts");
  const [panel, recallMsg] = await Promise.all([
    readZzzPanelConfigDocument(legacyResources, root),
    readZzzRecallSeconds(zzzPanelConfigFile(root), legacyResources?.trim()),
  ]);
  return { panel, values: { ...parseZzzPanelConfig(panel), recallMsg } };
}

export async function updateZzzPanelIntervals(root: URL, values: Partial<PanelValues>,
  active: () => boolean, signal: AbortSignal, previous?: PanelValues, legacyResources?: string) {
  const { zzzPanelConfigFile } = await import("../plugins/zzz/panel-command.ts");
  return updateLocalConfiguration(root, "zzz-panel", {
    override: zzzPanelConfigFile(root), canWrite: active, canCommit: active, signal,
    resolveEffective: () => readPanelSettings(root, legacyResources),
    prepare(text, local, effective) {
      const { panel, values: current } = effective as Awaited<ReturnType<typeof readPanelSettings>>;
      if (previous && !isDeepStrictEqual(current, previous)) throw new GlobalConfigWriteError("conflict");
      const next = requestedPanel({ ...current, ...values });
      const changes = Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== current[key as keyof PanelValues] ||
        (key === "recallMsg" && !previous && values.recallMsg !== undefined && local.recallMsg !== value)));
      if (!Object.keys(changes).length) return { value: current };
      const saved = { ...(text.trim() ? {} : panel), ...changes };
      return { yaml: edit(text, local, saved), value: next };
    },
  });
}

export function panelZzzSettings(root: URL, section: "rank" | "panel" | "reminders" = "rank") {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    let body: Document | undefined;
    if (request.method === "PUT") {
      try {
        body = object(await readPanelJson(request));
        if (!body || Object.keys(body).length !== 2 || !Object.hasOwn(body, "previous") || !Object.hasOwn(body, "values")) {
          throw new Error("无效的设置请求");
        }
      } catch { return new Response(null, { status: 400 }); }
    }

    try {
      if (section === "reminders") {
        const { createZzzChallengeReminderStore, challengeReminderTime } = await import("../plugins/zzz/challenge-reminder-store.ts");
        const redis = globalThis.redis;
        if (!redis) return new Response(null, { status: 503 });
        const store = createZzzChallengeReminderStore(redis);
        if (!body) {
          const values = await store.global();
          return active() ? Response.json({ fields: reminderFields, values }) : new Response(null, { status: 401 });
        }
        function requested(input: unknown): ChallengeReminderDefaults {
          const values = object(input);
          if (!values || Object.keys(values).length !== reminderFields.length || typeof values.enable !== "boolean" ||
              typeof values.abyssCheckLevel !== "number" || !Number.isInteger(values.abyssCheckLevel) ||
              values.abyssCheckLevel < 0 || values.abyssCheckLevel > 6 ||
              typeof values.deadlyStars !== "number" || !Number.isInteger(values.deadlyStars) ||
              values.deadlyStars < 0 || values.deadlyStars > 9 ||
              typeof values.remindTime !== "string" || values.remindTime.length > 32) throw new Error("无效的挑战提醒设置");
          const { time } = challengeReminderTime(values.remindTime);
          if (!time) throw new Error("无效的挑战提醒时间");
          return { enable: values.enable, abyssCheckLevel: values.abyssCheckLevel, deadlyStars: values.deadlyStars, remindTime: time };
        }
        let previous: ChallengeReminderDefaults, values: ChallengeReminderDefaults;
        try { previous = requested(body.previous); values = requested(body.values); }
        catch { return new Response(null, { status: 400 }); }
        const result = await store.updateGlobalBatch(previous, values, () => active() && globalThis.redis === redis);
        if (result !== "saved") return new Response(null, { status: result === "conflict" ? 409 : 401 });
        return Response.json({ fields: reminderFields, values });
      }

      if (section === "rank") {
        const { readRankGroupSwitch, readZzzRankConfigDocument, resolveRankGroupSwitch, zzzRankConfigFile } =
          await import("../plugins/zzz/challenge-rank-store.ts");
        async function load() {
          const [document, live] = await Promise.all([readZzzRankConfigDocument(root), readRankGroupSwitch()]);
          return { document, live };
        }
        function snapshot({ document, live }: { document: Document; live: SwitchState }) {
          return { fields: rankFields, values: readRankValues(document, resolveRankGroupSwitch(document, live)) };
        }
        if (!body) {
          const result = snapshot(await load());
          return active() ? Response.json(result) : new Response(null, { status: 401 });
        }
        let previous: RankValues, values: RankValues;
        try { previous = requestedRank(body.previous); values = requestedRank(body.values); }
        catch { return new Response(null, { status: 400 }); }
        return Response.json(await updateLocalConfiguration(root, "zzz-rank", {
          override: zzzRankConfigFile(root), canWrite: active, canCommit: active, signal: request.signal,
          resolveEffective: load,
          prepare(text, local, effective) {
            const state = effective as Awaited<ReturnType<typeof load>>;
            const current = snapshot(state).values;
            if (!isDeepStrictEqual(current, previous)) throw new GlobalConfigWriteError("conflict");
            const changes = fieldsChanged(current, values);
            if (!Object.keys(changes).length) return { value: snapshot(state) };
            // A new local file shadows the old rank reference. Carry forward its existing preferences.
            const saved: Document = {
              ...(text.trim() ? {} : state.document),
              ...changes,
              ...(current.allow_group === values.allow_group ? {} : { previous_chat_rank_switch: state.live.stamp }),
            };
            return { yaml: edit(text, local, saved), value: snapshot({ document: { ...state.document, ...saved }, live: state.live }) };
          },
        }));
      }

      if (!body) {
        const { values } = await readPanelSettings(root);
        return active() ? Response.json({ fields: panelFields, values }) : new Response(null, { status: 401 });
      }
      let previous: PanelValues, values: PanelValues;
      try { previous = requestedPanel(body.previous); values = requestedPanel(body.values); }
      catch { return new Response(null, { status: 400 }); }
      return Response.json({ fields: panelFields, values: await updateZzzPanelIntervals(root, values, active, request.signal, previous) });
    } catch (error) {
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" || reason === "cancelled" ? 401 : 503 });
    }
  };
}
