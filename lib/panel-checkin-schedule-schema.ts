export const scheduleCronFields = ["plan_generate_cron", "run_due_cron", "catch_up_cron"] as const;
export type ScheduleCronField = typeof scheduleCronFields[number];

export const scheduleWindowFields = {
  random: ["window_start", "window_end", "notify_before"],
  late_registration: ["window_start", "window_end", "enable", "notify"],
} as const;
type TimeWindow = { window_start: string; window_end: string };
export type RandomScheduleSettings = TimeWindow & { notify_before: boolean };
export type LateScheduleSettings = TimeWindow & { enable: boolean; notify: boolean };

export type CheckinSchedulePanelSettings = {
  enable: boolean;
  mode: "fixed" | "random";
  fixed_time: string;
  random: RandomScheduleSettings;
  late_registration: LateScheduleSettings;
} & Record<ScheduleCronField, string>;

export interface CheckinSchedulePanelSnapshot {
  readonly revision: string;
  readonly settings: CheckinSchedulePanelSettings;
  readonly invalidCrons: readonly ScheduleCronField[];
}
