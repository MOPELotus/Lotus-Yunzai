import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { parseGachaDisplaySettings, type GachaDisplaySettings } from "@lotus-yunzai/gacha/display-settings";
import { gachaDisplayConfigBytes, gachaDisplayConfigName, readGachaDisplayConfig } from "./gacha-display-settings.ts";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";

const fields = [
  { key: "enabled", label: "显示欧皇度", type: "boolean" },
  { key: "minSample", label: "欧皇度最少样本数", type: "number", min: 0, max: Number.MAX_SAFE_INTEGER,
    hint: "少于此数会提示样本较少。限定池按已确认的 UP 五星数，其他池按五星数。" },
  { key: "detailRows", label: "每张详情图的五星条数", type: "number", min: 0, max: Number.MAX_SAFE_INTEGER,
    hint: "不计当前垫抽。填 0 在一张图显示全部；顶部仍按全部记录统计。" },
  { key: "versionRows", label: "每张统计图的卡池期数", type: "number", min: 0, max: Number.MAX_SAFE_INTEGER,
    hint: "填 0 在一张图显示全部期数。" },
  { key: "levels", label: "欧皇度评级", type: "json",
    hint: "按所列顺序使用首个达到门槛的评级。每项包括 min、title、desc、color；颜色使用十六进制。" },
  { key: "models", label: "欧皇度出金概率模型覆盖", type: "json",
    hint: "留 {} 使用默认模型。可按游戏和卡池填部分覆盖。原神 gs 下有 301、302、200、500，星铁 sr 下有 11、12、1。池内字段 base、soft、step、hard、upRate。" },
] as const;

function flatten({ luck, detailRows, versionRows, models }: GachaDisplaySettings) {
  return { ...luck, detailRows, versionRows, models };
}

function input(value: unknown) {
  if (!value || typeof value !== "object" || Object.keys(value).length !== fields.length ||
      !fields.every(({ key }) => Object.hasOwn(value, key))) return;
  return flatten(parseGachaDisplaySettings(value));
}

export function panelGachaSettings(root: URL) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    try {
      if (request.method === "GET") {
        const values = flatten(parseGachaDisplaySettings(await readGachaDisplayConfig(root)));
        return active() ? Response.json({ fields, values }) : new Response(null, { status: 401 });
      }
      const body = await readPanelJson(request, gachaDisplayConfigBytes).catch(() => undefined);
      if (!body || typeof body !== "object" || !("previous" in body) || !("values" in body)) {
        return new Response(null, { status: 400 });
      }
      let previous: ReturnType<typeof input>, values: ReturnType<typeof input>;
      try {
        previous = input(body.previous);
        values = input(body.values);
      } catch (error) {
        return Response.json({ message: (error as Error).message }, { status: 400 });
      }
      if (!previous || !values) return new Response(null, { status: 400 });
      const snapshot = { fields, values };
      const saved = await updateLocalConfiguration(root, gachaDisplayConfigName, {
        signal: request.signal, canWrite: active, canCommit: active,
        prepare(text, local) {
          const current = flatten(parseGachaDisplaySettings(local));
          if (!isDeepStrictEqual(current, previous)) throw new GlobalConfigWriteError("conflict");
          const changed = fields.filter(({ key }) => !isDeepStrictEqual(current[key], values[key]));
          if (!changed.length) return { value: snapshot };
          const document = parseDocument(text, { strict: true, uniqueKeys: true });
          if (document.errors.length) throw new GlobalConfigWriteError("config");
          for (const { key } of changed) document.set(key, values[key]);
          const yaml = document.toString({ lineWidth: 0 });
          if (Buffer.byteLength(yaml) > gachaDisplayConfigBytes ||
              !isDeepStrictEqual(flatten(parseGachaDisplaySettings(Bun.YAML.parse(yaml))), values)) {
            throw new GlobalConfigWriteError("config");
          }
          return { yaml, value: snapshot };
        },
      });
      return Response.json(saved);
    } catch (error) {
      if (!active() || error instanceof GlobalConfigWriteError && error.reason === "permission") return new Response(null, { status: 401 });
      return new Response(null, { status: error instanceof GlobalConfigWriteError && error.reason === "conflict" ? 409 : 500 });
    }
  };
}
