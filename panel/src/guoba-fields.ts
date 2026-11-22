import type { GuobaField } from "../../lib/panel-guoba.ts";
import type { InjectionKey } from "vue";
import type { PanelAuth } from "./api.ts";

export const guobaPanelAuth: InjectionKey<() => PanelAuth> = Symbol("guobaPanelAuth");

export function isSpecialGuobaField({ component }: GuobaField) {
  return component === "GTags" || component === "GSelectGroup" || component === "GSelectFriend" ||
    component === "GColorPicker" || component === "DatePicker" || component === "TimePicker" || component === "TreeSelect";
}
