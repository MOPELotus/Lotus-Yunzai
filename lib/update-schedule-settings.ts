export const defaultUpdateCron = "0 30 0,12 * * *";

/** Either explicit setting, including zero/empty values, overrides the default. */
export function withDefaultUpdateSchedule(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.hasOwn(config, "update_time") || Object.hasOwn(config, "update_cron")
    ? { ...config } : { ...config, update_cron: defaultUpdateCron };
}
