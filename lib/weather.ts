import { withReadRetries } from "@lotus-yunzai/http";
const matchingEndpoint = "https://wis.qq.com/city/matching";
const weatherEndpoint = "https://i.news.qq.com/weather/common";
const forecastTypes = "observe|forecast_1h|forecast_24h|index|alarm|limit|tips|rise";
const maxPayloadBytes = 512 * 1024;

type Area = { readonly province: string; readonly city: string; readonly district: string };
type WeatherFields = Readonly<Record<string, unknown>>;
export type WeatherTransport = (url: URL, init: RequestInit) => Promise<Response>;

function object(value: unknown): WeatherFields | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as WeatherFields : undefined;
}

function items(value: unknown) {
  return Array.isArray(value) ? value : Object.values(object(value) ?? {});
}

function clean(value: unknown, size = 48) {
  return typeof value === "string" && value.isWellFormed()
    ? value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, size) : "";
}

function number(value: unknown) {
  const parsed = (typeof value === "string" && /^-?\d+(?:\.\d+)?$/u.test(value)) || typeof value === "number"
    ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseWeatherCommand(message: string) {
  const match = /^(#?)([\p{Script=Han} \t]{0,30})天气$/u.exec(message.trim());
  if (!match) return;
  const city = match[2]!.trim().replace(/\s+/gu, " ");
  const explicit = match[1] === "#";
  if (/^(?:原神|星铁|绝区零|小飞|设置)/u.test(city)) return;
  if (!explicit && (!city || /今天|明天|后天|什么|怎么样|感觉|好坏|喜欢|最近|查看|想要|想看|看看|预报|的/u.test(city))) return;
  return { explicit, city: city === "地区" ? "" : city };
}

function locality(value: string) {
  return value.replace(/(?:特别行政区|自治区|自治州|自治县|省|市|区|县)$/u, "");
}

function areaCandidates(query: string) {
  const parts = query.match(/[\p{Script=Han}]+?(?:省|市|区|县)(?=[\p{Script=Han}]|\s|$)|[\p{Script=Han}]+/gu) ?? [];
  return [...new Set([(parts.at(-1) ?? query).trim(), locality(parts.at(-1) ?? query), query.replaceAll(" ", "")])]
    .filter(Boolean);
}

function areaMatches(value: Area, target: string, raw: string) {
  const a = locality(value.province);
  const b = locality(value.city);
  const c = locality(value.district);
  const provinceNames = [a];
  const cityNames = value.district ? [] : [b, a + b];
  const districtNames = c ? [c, b + c, a + b + c, a + c] : [];
  const names = /(?:省|自治区|特别行政区)$/u.test(raw) ? provinceNames
    : /(?:市|自治州)$/u.test(raw) ? [...cityNames, ...districtNames]
    : /(?:区|县)$/u.test(raw) ? districtNames : [...provinceNames, ...cityNames, ...districtNames];
  return names.some(candidate => candidate.replace(/(省|市|区|县)/gu, "") === target);
}

function matchingAreas(response: WeatherFields, query: string): readonly Area[] {
  const target = query.replace(/\s+/gu, "").replace(/特别行政区|自治区|自治州|自治县|省|市|区|县/gu, "");
  const matches = Object.entries(object(response.internal) ?? {}).flatMap(([id, value]) => {
    if (!/^\d{8,12}$/u.test(id) || typeof value !== "string") return [];
    const [province = "", city = "", district = "", excess] = value.split(/\s*[,，]\s*/u);
    if (excess || !province || !city || ![province, city, district].every(piece => /^[\p{Script=Han}]{0,24}$/u.test(piece))) return [];
    const area = { province, city, district };
    return areaMatches(area, target, query) ? [area] : [];
  });
  // The service's county-level city is stored in the district field.
  if (!/(?:市|自治州)$/u.test(query)) return matches;
  const cities = matches.filter(area => !area.district);
  return cities.length ? cities : matches;
}

export function formatWeatherArea({ province, city, district }: Area) {
  return [...new Set([province, city, district].filter(Boolean))].join(" · ");
}

function compactTime(value: unknown, hour = false) {
  if (typeof value !== "string") return "";
  const match = /^(\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])([01]\d|2[0-3])([0-5]\d)(?:[0-5]\d)?$/u.exec(value);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${hour ? "00" : match[5]}` : "";
}

function temperature(value: unknown) {
  const amount = number(value);
  return amount !== undefined && amount >= -100 && amount <= 80 ? `${amount}°` : "";
}

function joinFields(...fields: string[]) {
  return fields.filter(Boolean).join(" · ");
}

export interface WeatherReport {
  readonly area: string;
  readonly current: string;
  readonly updated: string;
  readonly conditions: readonly string[];
  readonly hourly: readonly string[];
  readonly daily: readonly string[];
  readonly lifestyle: readonly string[];
  readonly warnings: readonly string[];
}

function decodeWeather(area: Area, forecast: WeatherFields, cityAir?: WeatherFields): WeatherReport | undefined {
  const observation = object(forecast.observe);
  const updated = compactTime(observation?.update_time);
  const observedHour = compactTime(observation?.update_time, true);
  const currentTemperature = temperature(observation?.degree);
  const currentWeather = clean(observation?.weather);
  if (!currentTemperature || !currentWeather || !updated) return;
  const current = joinFields(currentTemperature + "C", currentWeather);
  const hourly = items(forecast.forecast_1h).flatMap(item => {
    const hour = object(item);
    const time = compactTime(hour?.update_time);
    const degree = temperature(hour?.degree);
    const weather = clean(hour?.weather);
    return time && degree && weather && time >= observedHour ? [[time, joinFields(time.slice(11), weather, degree)] as const] : [];
  }).sort(([a], [b]) => a.localeCompare(b)).slice(0, 24).map(([, summary]) => summary);
  const daily = items(forecast.forecast_24h).flatMap(item => {
    const day = object(item);
    const date = clean(day?.time);
    const minimum = temperature(day?.min_degree);
    const maximum = temperature(day?.max_degree);
    const dayWeather = clean(day?.day_weather);
    const nightWeather = clean(day?.night_weather);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || date < updated.slice(0, 10) || !minimum || !maximum || !dayWeather) return [];
    return [[date, joinFields(date.slice(5), dayWeather === nightWeather || !nightWeather ? dayWeather : `${dayWeather}转${nightWeather}`,
      `${minimum} / ${maximum}`, clean(day?.day_wind_direction), clean(day?.day_wind_power))] as const];
  }).sort(([a], [b]) => a.localeCompare(b)).slice(0, 7).map(([, summary]) => summary);
  if (!hourly.length || !daily.length) return;
  const air = object(cityAir?.air) ?? object(forecast.air);
  const today = updated.slice(0, 10).replaceAll("-", "");
  const rise = items(forecast.rise).map(object).find(item => item?.time === today);
  const humidity = number(observation?.humidity);
  const pressure = number(observation?.pressure);
  const precipitation = number(observation?.precipitation);
  const quality = number(air?.aqi);
  const conditions = [
    joinFields(clean(observation?.wind_direction_name), clean(observation?.wind_power) && `${clean(observation?.wind_power)} 级`),
    humidity !== undefined ? `湿度 ${humidity}%` : "",
    pressure !== undefined ? `气压 ${pressure} hPa` : "",
    precipitation !== undefined ? `降水 ${precipitation} mm` : "",
    quality !== undefined ? joinFields(`空气质量 ${quality}`, clean(air?.aqi_name)) : "",
    joinFields(clean(rise?.sunrise) && `日出 ${clean(rise?.sunrise)}`, clean(rise?.sunset) && `日落 ${clean(rise?.sunset)}`),
    clean(object(forecast.limit)?.tail_number) && `限行 ${clean(object(forecast.limit)?.tail_number)}`,
  ].filter(Boolean);
  const lifestyle = Object.values(object(forecast.index) ?? {}).flatMap(item => {
    const index = object(item);
    const title = clean(index?.name);
    const value = clean(index?.info);
    return title && value ? [joinFields(title, value)] : [];
  }).slice(0, 24);
  const warnings = items(forecast.alarm).flatMap(item => {
    const alarm = object(item);
    const title = clean(alarm?.type_name);
    const level = clean(alarm?.level_name);
    const detail = clean(alarm?.detail, 320);
    return title && level ? [joinFields(`${title}${level}预警`, detail)] : [];
  }).slice(0, 6);
  const tips = Object.values(object(object(forecast.tips)?.observe) ?? {}).map(item => clean(item, 120)).filter(Boolean).slice(0, 2);
  return { area: formatWeatherArea(area), current, updated: updated.slice(5), conditions: [...conditions, ...tips], hourly, daily, lifestyle, warnings };
}

async function request(endpoint: string, query: Record<string, string>, signal: AbortSignal, transport: WeatherTransport) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams(query).toString();
  const response = await withReadRetries(transport)(url, {
    credentials: "omit", redirect: "error", signal,
    headers: { Accept: "application/json", Referer: "https://tianqi.qq.com/" },
  });
  if (!response.ok || response.redirected || !response.body || Number(response.headers.get("content-length")) > maxPayloadBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("天气请求失败。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxPayloadBytes) throw new Error("天气响应超限。");
      text += decoder.decode(value, { stream: true });
    }
    const envelope = object(JSON.parse(text + decoder.decode()));
    if (envelope?.status !== 200 && envelope?.status !== "200") throw new Error("天气服务暂时不可用。");
    return object(envelope.data) ?? {};
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export type WeatherResult = WeatherReport | { readonly message: string };

export async function fetchWeather(query: string, lifecycle: AbortSignal, transport: WeatherTransport = fetch): Promise<WeatherResult> {
  const signal = AbortSignal.any([lifecycle, AbortSignal.timeout(8_000)]);
  try {
    let area: Area | undefined;
    for (const city of areaCandidates(query)) {
      const matches = matchingAreas(await request(matchingEndpoint, { source: "xw", city }, signal, transport), query);
      if (matches.length > 1) return { message: `找到多个同名地区，请补上省市。\n${matches.slice(0, 8).map(formatWeatherArea).join("\n")}` };
      if (matches[0]) {
        area = matches[0];
        break;
      }
    }
    if (!area) return { message: "没有查询到该地区的天气！" };
    const { province, city, district } = area;
    const [forecast, air] = await Promise.all([
      request(weatherEndpoint, { source: "pc", weather_type: forecastTypes, province, city, county: district }, signal, transport),
      request(weatherEndpoint, { source: "pc", weather_type: "air|rise", province, city }, signal, transport).catch(() => undefined),
    ]);
    return decodeWeather(area, forecast, air) ?? { message: "天气服务返回的数据不完整，请稍后再试。" };
  } catch {
    return { message: "天气服务暂时无法连接，请稍后再试。" };
  }
}
