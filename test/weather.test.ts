import { expect, test } from "bun:test";
import { weatherCommands } from "../lib/weather-command.ts";
import { fetchWeather, parseWeatherCommand, type WeatherTransport } from "../lib/weather.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const lookup = { "101051206": "黑龙江, 鹤岗, 南山", "101280604": "广东, 深圳, 南山" };
const signal = new AbortController().signal;
const observation = {
  observe: { degree: 0, humidity: 0, weather: "晴", update_time: "202612312350", wind_direction_name: "北风", wind_power: "3-4" },
  forecast_1h: {
    "1": { degree: "-1", weather: "晴", update_time: "20270101000000" },
    "0": { degree: "0", weather: "晴", update_time: "20261231230000" },
  },
  forecast_24h: [
    { min_degree: -5, max_degree: 7, day_weather: "晴", night_weather: "多云", time: "20270101" },
    { min_degree: -5, max_degree: 7, day_weather: "晴", night_weather: "多云", time: "2027-01-01" },
    { min_degree: -2, max_degree: 8, day_weather: "晴", night_weather: "晴", time: "2026-12-31" },
    { min_degree: -3, max_degree: 6, day_weather: "多云", time: "2026-12-30" },
  ],
  index: { clothes: { name: "穿衣", info: "较冷" } },
  alarm: [{ type_name: "大风", level_name: "蓝色", detail: "阵风 7 级" }],
  limit: { tail_number: "不限行" },
  rise: [{ sunrise: "06:55", sunset: "17:55", time: "20270101" }, { sunrise: "07:18", sunset: "17:20", time: "20261231" }],
};

test("天气回复只认规范查询，区分显式提示和普通聊天", async () => {
  expect(parseWeatherCommand("#广东省 深圳市 南山区天气")).toEqual({ city: "广东省 深圳市 南山区", explicit: true });
  expect(parseWeatherCommand("海淀天气")).toEqual({ city: "海淀", explicit: false });
  expect(parseWeatherCommand("看看明天的天气")).toBeUndefined();
  expect(parseWeatherCommand("#小飞北京天气")).toBeUndefined();
  expect(parseWeatherCommand("#星铁北京天气")).toBeUndefined();
  expect(parseWeatherCommand("#天气")).toEqual({ city: "", explicit: true });

  const queries: string[] = [];
  const controller = new AbortController();
  const module = weatherCommands(controller.signal, async city => {
    queries.push(city);
    return { message: "没有查询到该地区的天气！" };
  });
  const context = { normalizedMessage: "", message_type: "private" as const, isMaster: false, isBotMaster: () => false,
    reply() { return true; } };
  expect(await module.fallback?.("#天气", context)).toEqual({ type: "quoted", message: "格式：#地区天气\n例如：#北京天气" });
  expect(await module.fallback?.("未找到天气", context)).toBeUndefined();
  expect(await module.fallback?.("#未找到天气", context)).toEqual({ type: "quoted", message: "没有查询到该地区的天气！" });
  expect(await module.fallback?.("#南山天气", { ...context, isDelegated: true })).toBeUndefined();
  controller.abort();
  expect(await module.fallback?.("#南山天气", context)).toBeUndefined();
  expect(queries).toEqual(["未找到", "未找到"]);
});

test("同名地区先收敛；区县预报和同城 AQI 独立请求，按原时区跨年排序", async () => {
  const requests: URL[] = [];
  const transport: WeatherTransport = async (url, init) => {
    requests.push(url);
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(init.headers).not.toHaveProperty("Cookie");
    const data = url.hostname === "wis.qq.com" ? { internal: lookup }
      : url.searchParams.get("weather_type") === "air|rise" ? { air: { aqi: 44, aqi_name: "优" } } : observation;
    return Response.json({ status: 200, data });
  };
  expect(await fetchWeather("南山", signal, transport)).toEqual({ message: "找到多个同名地区，请补上省市。\n黑龙江 · 鹤岗 · 南山\n广东 · 深圳 · 南山" });
  expect(requests).toHaveLength(1);
  const report = await fetchWeather("广东省 深圳市 南山区", signal, transport);
  expect(report).toEqual({
    area: "广东 · 深圳 · 南山", current: "0°C · 晴", updated: "12-31 23:50",
    conditions: ["北风 · 3-4 级", "湿度 0%", "空气质量 44 · 优", "日出 07:18 · 日落 17:20", "限行 不限行"],
    hourly: ["23:00 · 晴 · 0°", "00:00 · 晴 · -1°"],
    daily: ["12-31 · 晴 · -2° / 8°", "01-01 · 晴转多云 · -5° / 7°"],
    lifestyle: ["穿衣 · 较冷"], warnings: ["大风蓝色预警 · 阵风 7 级"],
  });
  expect(requests[1]?.searchParams.get("city")).toBe("南山区");
  expect(requests[2]?.host).toBe("i.news.qq.com");
  expect(requests[2]?.searchParams.get("county")).toBe("南山");
  expect(requests[3]?.searchParams.has("county")).toBeFalse();
});

test("天气主请求失败有明确回执，空气质量失败仍可出图", async () => {
  const transport: WeatherTransport = async url => url.host === "wis.qq.com"
    ? Response.json({ status: 200, data: { internal: { "101010100": "北京, 北京" } } })
    : url.searchParams.get("weather_type") === "air|rise"
    ? new Response(null, { status: 503 })
    : Response.json({ status: 200, data: observation });
  const report = await fetchWeather("北京", signal, transport);
  expect(report).toMatchObject({ current: "0°C · 晴" });
  if ("message" in report) throw new Error(report.message);
  expect(report.conditions.some(value => value.includes("空气质量"))).toBeFalse();
  expect(await fetchWeather("北京", signal, async url => url.host === "wis.qq.com" ? transport(url, {}) : new Response(null, { status: 503 })))
    .toEqual({ message: "天气服务暂时无法连接，请稍后再试。" });
});

test("市、区后缀区分同名地区，并兼容腾讯将县级市归入区县字段", async () => {
  const transport: WeatherTransport = async url => {
    const city = url.searchParams.get("city");
    const data = url.host !== "wis.qq.com" ? observation : {
      internal: city === "朝阳" ? { "101010300": "北京, 北京, 朝阳", "101071201": "辽宁, 朝阳" }
        : city === "都江堰" ? { "101270111": "四川, 成都, 都江堰" } : null,
    };
    return Response.json({ status: "200", data });
  };
  expect(await fetchWeather("朝阳市", signal, transport)).toMatchObject({ area: "辽宁 · 朝阳" });
  expect(await fetchWeather("朝阳区", signal, transport)).toMatchObject({ area: "北京 · 朝阳" });
  expect(await fetchWeather("都江堰市", signal, transport)).toMatchObject({ area: "四川 · 成都 · 都江堰" });
});

test("宿主从 OneBot 和 Milky 的普通成员命令分发天气用法", async () => {
  await withDualGatewayFixture("weather-fixture", "disablePrivate: false\n",
    async ({ onebot, milky, sendOneBot, sendMilky }) => {
      sendOneBot("#天气");
      await sendMilky("#地区天气");
      const onebotReply = await onebot.next("send_msg");
      expect(JSON.stringify(onebotReply.params.message)).toContain("#北京天气");
      onebotReply.respond({ message_id: 80 });
      const milkyReply = await milky.next("send_private_message");
      expect(JSON.stringify(milkyReply.params.message)).toContain("#北京天气");
      milkyReply.respond({ message_seq: 81 });
    });
}, 10_000);
