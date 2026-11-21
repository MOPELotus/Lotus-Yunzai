export const scheduleCronFields = ["plan_generate_cron", "run_due_cron", "catch_up_cron"] as const;
export type ScheduleCronField = typeof scheduleCronFields[number];

export type CheckinSchedulePanelSettings = {
  enable: boolean;
  mode: "fixed" | "random";
  fixed_time: string;
} & Record<ScheduleCronField, string>;

export interface CheckinSchedulePanelSnapshot {
  readonly revision: string;
  readonly settings: CheckinSchedulePanelSettings;
  readonly invalidCrons: readonly ScheduleCronField[];
}
