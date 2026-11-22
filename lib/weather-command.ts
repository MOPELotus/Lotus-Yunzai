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
      if (!city) return explicit ? { type: "quoted", message: "格式：#地区天气\n例如：#北京天气" } : undefined;
      let request = pending.get(city);
      if (!request) {
        if (pending.size >= maxQueries) return explicit ? "天气查询较忙，请稍后再试。" : undefined;
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
        return [`${report.area}天气 · ${report.updated} 更新`, report.current, ...report.conditions,
          ...report.warnings, ...report.daily].join("\n");
      } catch {
        return !signal.aborted && explicit ? "天气查询暂时失败，请稍后再试。" : undefined;
      }
    },
  };
}
