import type { GuobaField } from "../../lib/panel-guoba.ts";

export function isSpecialGuobaField({ component }: GuobaField) {
  return component === "GTags" || component === "GSelectGroup" || component === "GSelectFriend" ||
    component === "GColorPicker" || component === "DatePicker" || component === "TimePicker" || component === "TreeSelect";
}
