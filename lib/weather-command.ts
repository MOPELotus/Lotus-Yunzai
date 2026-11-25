import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { nativeImageRasterScale } from "@lotus-yunzai/skia";
import type { CommandModule } from "./commands.ts";
import { segment } from "./messages.ts";
import { renderWeatherCard } from "./weather-card.ts";
import { fetchWeather, parseWeatherCommand, type WeatherResult } from "./weather.ts";

export function weatherCommands(signal: AbortSignal, query = fetchWeather, render = renderWeatherCard): CommandModule {
  const pending = new Map<string, Promise<WeatherResult>>();
  const maxQueries = 4;

  return {
    name: "@lotus-yunzai/weather",
    commands: {},
    async fallback(message, context) {
      if (context.isDelegated || signal.aborted) return;
      const command = parseWeatherCommand(message);
      if (!command) return;
      const { city, explicit } = command;
      if (!city) return explicit ? { type: "quoted", message: $t("lib.weather-command.text_23da2a85f6") } : undefined;
      let request = pending.get(city);
      if (!request) {
        if (pending.size >= maxQueries) return explicit ? $t("lib.weather-command.text_ff5d8273d8") : undefined;
        request = Promise.resolve().then(() => query(city, signal)).finally(() => pending.delete(city));
        pending.set(city, request);
      }
      try {
        const report = await request;
        if (signal.aborted) return;
        if ("message" in report) return explicit ? { type: "quoted", message: report.message } : undefined;
        const scale = nativeImageRasterScale();
        const limit = context.inlineImageByteLimit ?? Number.POSITIVE_INFINITY;
        let image = await render(report, scale);
        if (image.png.byteLength > limit && scale === 4) image = await render(report, 2);
        if (signal.aborted) return;
        if (image.png.byteLength <= limit) return segment.image(image.png);
        return [$t("lib.weather-command.text_1cb45ebbc8", { "area": report.area, "updated": report.updated }), report.current, ...report.conditions,
          ...report.warnings, ...report.daily].join("\n");
      } catch {
        return !signal.aborted && explicit ? $t("lib.weather-command.text_9a86e4f753") : undefined;
      }
    },
  };
}
