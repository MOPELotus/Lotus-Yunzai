import "./language.ts";
import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import type { MiyousheOverview } from "../../lib/miyoushe-overview.ts";
import type { createMiyousheShopCatalog } from "../../lib/miyoushe-shop-catalog.ts";
import type { createMiyousheShopPlans } from "../../lib/miyoushe-shop-plans.ts";
import { createIntentId } from "./intent-id.js";
import type {
  MiyousheCheckinSettings,
  MiyousheCheckinSettingsPatch,
  MiyousheManualCheckinResult,
  MiyoushePreviewSettings,
  MiyoushePreviewSettingsPatch,
} from "../../lib/miyoushe-web.ts";

type Timer = ReturnType<typeof setTimeout>;
type Tab = "overview" | "shop" | "trackers" | "plans";
type Overview = MiyousheOverview & {
  readonly expiresAt: number;
  readonly previewSettingsAvailable: boolean;
  readonly checkinSettingsAvailable: boolean;
  readonly manualCheckinAvailable: boolean;
};
type Mission = NonNullable<MiyousheOverview["missions"]>["items"][number];
type Catalog = ReturnType<typeof createMiyousheShopCatalog>;
type CatalogData = Awaited<ReturnType<Catalog["list"]>>;
type CatalogDetail = Awaited<ReturnType<Catalog["detail"]>>;
type Good = CatalogData["goods"][number];
type TrackerProduct = { readonly id: string; readonly game: string; readonly type: 1 | 2 };
type Role = CatalogDetail["roles"][number];
type Address = { readonly id: string; readonly label: string };
type AccountQuota = NonNullable<Awaited<ReturnType<Catalog["accountQuota"]>>>;
type Detail = CatalogDetail & { readonly addresses?: readonly Address[]; readonly accountQuota?: AccountQuota };
type ShopPlans = ReturnType<typeof createMiyousheShopPlans>;
type PlanData = Awaited<ReturnType<ShopPlans["list"]>>;
type Plan = PlanData["plans"][number];
type TrackerTargets = Awaited<ReturnType<ShopPlans["trackerTargets"]>>;
type TrackerRole = Extract<TrackerTargets, { type: "role" }>["items"][number];
type TrackerAddress = Extract<TrackerTargets, { type: "address" }>["items"][number];
type TrackerList = Awaited<ReturnType<ShopPlans["listTrackers"]>>;
type TrackerRow = TrackerList["trackers"][number];
type ActiveTracker = Extract<TrackerRow, { mode: unknown }> & { readonly migrationBlocked: false };
type BlockedTracker = Exclude<TrackerRow, { mode: unknown }> & { readonly migrationBlocked: true };
type TrackerData = Omit<TrackerList, "trackers"> & { readonly trackers: readonly (ActiveTracker | BlockedTracker)[] };
type ManualStatus = MiyousheManualCheckinResult["status"] | "loading" | "running" | "idle" | "unknown";

type CheckinSettings = MiyousheCheckinSettings & { readonly cloudBound: NonNullable<MiyousheCheckinSettings["cloudBound"]> };
type SettingsByKey = { preview: MiyoushePreviewSettings; checkin: CheckinSettings };
type SettingsKey = keyof SettingsByKey;
type Flags = Readonly<Record<string, boolean>>;
type SettingsPatch = {
  preview: Omit<MiyoushePreviewSettingsPatch, "revision" | "games"> & { readonly revision?: string; readonly games: readonly string[] };
  checkin: Omit<MiyousheCheckinSettingsPatch, "revision" | "games" | "cloud" | "os"> &
    { readonly revision?: string; readonly games: Flags; readonly cloud: Flags; readonly os: Flags };
};
interface ProfileEditor<Key extends SettingsKey> {
  readonly key: Key;
  data: SettingsByKey[Key] | null;
  active: AbortController | null;
  patch(): SettingsPatch[Key];
  buttons(): void;
  render(data: SettingsByKey[Key]): string;
}

interface ReservationIntent {
  readonly body: {
    readonly goodsId: string;
    readonly expectedPrice: number;
    readonly immediate: boolean;
    readonly confirmed: true;
    readonly intentId: string;
    readonly uid?: string;
    readonly region?: string;
    readonly addressId?: string;
  };
  submitting?: boolean;
  uncertain?: boolean;
  note?: string;
}
interface TrackerForm extends HTMLFormElement {
  readonly elements: HTMLFormControlsCollection &
    Record<"mode" | "game" | "itemType" | "destination", HTMLSelectElement> &
    Record<"keywords" | "goodsIds" | "followSameName" | "maxPrice" | "spendLimit" |
      "pollMinutes" | "leadSeconds" | "intervalMs" | "confirmed", HTMLInputElement>;
}
type ElementsById = Record<"manual-checkin-start" | "preview-settings-save" | "checkin-settings-save" |
  "refresh" | "logout" | "login-retry" | "shop-previous" | "shop-next" | "tracker-open" | "tracker-submit", HTMLButtonElement> &
  Record<"preview-enabled" | "checkin-enabled" | "checkin-notify" | "checkin-community" |
    "checkin-os-enabled" | "checkin-cloud-genshin" | "checkin-cloud-zzz" | "shop-search", HTMLInputElement> &
  Record<"preview-games" | "checkin-games" | "checkin-switches" | "checkin-forums" | "checkin-cloud" | "checkin-os", HTMLFieldSetElement> &
  Record<"preview-settings-form" | "checkin-settings-form", HTMLFormElement> &
  Record<"shop-game" | "shop-status", HTMLSelectElement> &
  Record<"shop-detail" | "tracker-dialog", HTMLDialogElement> &
  { "tracker-form": TrackerForm };

const get = <Id extends string>(id: Id) =>
  document.getElementById(id) as Id extends keyof ElementsById ? ElementsById[Id] : HTMLElement;
const clock = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const expiry = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "numeric", day: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const shopClock = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const number = new Intl.NumberFormat("zh-CN");
const games = { gs: $t("web.miyoushe.app.text_d1597c51ed"), sr: $t("web.miyoushe.app.text_8cfc959b53"), zzz: $t("web.miyoushe.app.text_b1110352c9") };
const loginHelp = $t("web.miyoushe.app.text_ec909a7c6f");
let busy = false;
let pendingTicket = false;
let expiryTimer: Timer | undefined;
let tab: Tab = "overview";
const shopStatuses = { available: $t("web.miyoushe.app.text_ee341919f3"), scheduled: $t("web.miyoushe.app.text_90624b0fd7"), sold_out: $t("web.miyoushe.app.text_fff0472ba2"), ended: $t("web.miyoushe.app.text_d79b1d0e5c"), unknown: $t("web.miyoushe.app.text_cdea037991") };
const shop: {
  data: CatalogData | null; game: string; page: number; nowOffset: number;
  catalogRequest: AbortController | null; detailRequest: AbortController | null;
} = { data: null, game: "", page: 1, nowOffset: 0, catalogRequest: null, detailRequest: null };
const plans: {
  data: PlanData | null; loading: Promise<void> | null; timer: Timer | undefined; scope: number; revision: number;
  older: Map<string, Plan>; olderCursor: string | null | undefined; loadingOlder: boolean;
  activeForm: { readonly id: string; update(): void; reject(problem: string): void } | null;
  actions: Set<string>; intents: Map<string, ReservationIntent>;
} = { data: null, loading: null, timer: undefined, scope: 0, revision: 0, activeForm: null, actions: new Set(), intents: new Map(),
  older: new Map(), olderCursor: undefined, loadingOlder: false };
const preview: ProfileEditor<"preview"> = { key: "preview", data: null, active: null, patch: previewPatch, buttons: previewSettingsButtons, render: renderPreviewSettings };
const checkin: ProfileEditor<"checkin"> = { key: "checkin", data: null, active: null, patch: checkinPatch, buttons: checkinSettingsButtons, render: renderCheckinSettings };
const profileEditors = [checkin, preview];
const manualCheckin: { active: AbortController | null; timer: Timer | undefined; status: ManualStatus } = { active: null, timer: undefined, status: "loading" };
const trackers: {
  generation: number; targets: AbortController | null; loading: AbortController | null; data: TrackerData | null;
} = { generation: 0, targets: null, loading: null, data: null };
const trackGames = { hk4e: $t("web.miyoushe.app.text_d1597c51ed"), hkrpg: $t("web.miyoushe.app.text_8cfc959b53"), nap: $t("web.miyoushe.app.text_b1110352c9"), bh3: $t("web.miyoushe.app.text_6d3d8653d7"), bh2: $t("web.miyoushe.app.text_e5b1fba52e"), nxx: $t("web.miyoushe.app.text_a6e4fbed57"), bbs: $t("web.miyoushe.app.text_6ca05b2485") };
const planStatus = {
  scheduled: $t("web.miyoushe.app.text_90624b0fd7"), preparing: $t("web.miyoushe.app.text_65cb54b58d"), submitting: $t("web.miyoushe.app.text_6b70462dbb"), succeeded: $t("web.miyoushe.app.text_ab4d3a5515"),
  failed: $t("web.miyoushe.app.text_af0c4b935b"), cancelled: $t("web.miyoushe.app.text_a37778f17c"), missed: $t("web.miyoushe.app.text_67330e9d76"), unknown: $t("web.miyoushe.app.text_400d8fa7bd"),
};

function add<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className: string, value: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

function point(value: number | null | undefined) {
  return Number.isSafeInteger(value) && value! >= 0 ? number.format(value!) : "—";
}

function showLogin(message: string, help = false, retry = false) {
  clearTimeout(expiryTimer);
  get("dashboard").hidden = true;
  get("login").hidden = false;
  get("login-message").textContent = message;
  get("login-command").hidden = !help;
  get("login-profile-help").hidden = !help;
  get("login-retry").hidden = !retry;
  get("profile-name").textContent = "";
  get("profile").textContent = "";
  get("session-expiry").textContent = "";
  get("account-state").textContent = "";
  get("today-schedule").textContent = "";
  get("missions-remaining").hidden = true;
  get("missions-remaining").textContent = "";
  get("missions-empty").textContent = "";
  for (const id of ["balance", "received", "today-total"]) get(id).textContent = "—";
  for (const id of ["roles", "missions"]) get(id).replaceChildren();
  for (const editor of profileEditors) {
    editor.active?.abort();
    editor.active = null;
    editor.data = null;
    get(editor.key + "-settings").hidden = true;
    get((editor.key + "-settings-form") as `${SettingsKey}-settings-form`).reset();
    editor.buttons();
  }
  clearTimeout(manualCheckin.timer);
  manualCheckin.active?.abort();
  manualCheckin.active = null;
  manualCheckin.status = "loading";
  get("manual-checkin").hidden = true;
  get("manual-checkin-start").disabled = true;
  get("manual-checkin-status").textContent = "";
  get("manual-checkin-result").textContent = "";
  get("manual-checkin-result").hidden = true;
  resetShop();
  switchTab("overview");
}

function showManualCheckin(status: string, message = "") {
  const statusText: Record<ManualStatus, string> = {
    loading: $t("web.miyoushe.app.text_524e53ebee"), running: $t("web.miyoushe.app.text_a831887c1c"),
    completed: $t("web.miyoushe.app.text_6405679d0e"), failed: $t("web.miyoushe.app.text_02f00596e1"), busy: $t("web.miyoushe.app.text_28fa8fb1a2"),
    idle: "", unknown: $t("web.miyoushe.app.text_332f8f902e"),
  };
  manualCheckin.status = Object.hasOwn(statusText, status) ? status as ManualStatus : "unknown";
  get("manual-checkin-status").textContent = statusText[manualCheckin.status];
  get("manual-checkin-start").disabled = !["idle", "completed", "failed", "busy"].includes(manualCheckin.status);
  const result = get("manual-checkin-result");
  result.textContent = message;
  result.hidden = !message;
}

async function updateManualCheckin(start = false) {
  if (get("manual-checkin").hidden || manualCheckin.active) return;
  clearTimeout(manualCheckin.timer);
  const active = manualCheckin.active = new AbortController();
  const deadline = AbortSignal.any([active.signal, AbortSignal.timeout(20_000)]);
  if (start) showManualCheckin("loading");
  try {
    const response = await request("api/checkin-run", start ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: deadline,
    } : { signal: deadline });
    if (active.signal.aborted) return;
    if (response.status === 401) {
      showLogin($t("web.miyoushe.app.text_519e8af82e", { "loginHelp": loginHelp }), true);
      return;
    }
    if (response.status === 409 && start) {
      showManualCheckin("running");
      if (tab === "overview") manualCheckin.timer = setTimeout(() => void updateManualCheckin(), 2000);
      return;
    }
    if (!response.ok) {
      showManualCheckin("unknown", start ? await planFailure(response) : "");
      return;
    }
    const { status, message } = await response.json() as { status: string; message?: unknown };
    if (active.signal.aborted) return;
    showManualCheckin(status, typeof message === "string" ? message : "");
    if (status === "running" && tab === "overview") manualCheckin.timer = setTimeout(() => void updateManualCheckin(), 2000);
  } catch {
    if (!active.signal.aborted) showManualCheckin("unknown");
  } finally {
    if (manualCheckin.active === active) manualCheckin.active = null;
  }
}

function previewPatch() {
  return {
    enabled: get("preview-enabled").checked,
    games: Array.from(get("preview-games").querySelectorAll<HTMLInputElement>("input:checked"), input => input.value),
    revision: preview.data?.revision,
  };
}

function previewSettingsButtons() {
  const loaded = preview.data;
  get("preview-games").disabled = !loaded || Boolean(preview.active);
  get("preview-enabled").disabled = !loaded || Boolean(preview.active) || (loaded.canEnable === false && !loaded.enabled);
  const patch = previewPatch();
  get("preview-settings-save").disabled = !loaded || Boolean(preview.active) || (patch.enabled && !patch.games.length) ||
    (patch.enabled === loaded.enabled && patch.games.length === loaded.games.length && patch.games.every(game => loaded.games.includes(game as MiyoushePreviewSettings["games"][number])));
  get("preview-settings-form").setAttribute("aria-busy", String(Boolean(preview.active)));
}

function renderPreviewSettings(data: MiyoushePreviewSettings) {
  get("preview-enabled").checked = data.enabled;
  for (const input of get("preview-games").querySelectorAll("input")) input.checked = data.games.includes(input.value as MiyoushePreviewSettings["games"][number]);
  const messages = [];
  if (data.waitingForHistory) messages.push($t("web.miyoushe.app.text_c235916f7c"));
  if (data.canEnable === false && !data.enabled) messages.push($t("web.miyoushe.app.text_a3ca10856c"));
  return messages.join(" ");
}

const checkinSwitches = ["enabled", "notify", "community"] as const;
const checkinCloudGames = { genshin: $t("web.miyoushe.app.text_8d17468984"), zzz: $t("web.miyoushe.app.text_6e50693925") };

function checkedFlags(fieldset: string, selector = "input") {
  return Object.fromEntries(Array.from(get(fieldset).querySelectorAll<HTMLInputElement>(selector), input => [input.value, input.checked]));
}

function sameFlags(patch: Flags, saved: Flags) {
  return Object.entries(patch).every(([key, value]) => saved[key] === value);
}

function checkinPatch() {
  return {
    revision: checkin.data?.revision,
    enabled: get("checkin-enabled").checked,
    notify: get("checkin-notify").checked,
    community: get("checkin-community").checked,
    games: checkedFlags("checkin-games"),
    forums: Array.from(get("checkin-forums").querySelectorAll<HTMLInputElement>("input:checked"), input => Number(input.value)),
    cloud: checkedFlags("checkin-cloud"),
    osEnabled: get("checkin-os-enabled").checked,
    os: checkedFlags("checkin-os", 'input[name="os"]'),
  };
}

function checkinSettingsButtons() {
  const loaded = checkin.data;
  const pending = Boolean(checkin.active);
  for (const field of ["checkin-games", "checkin-switches", "checkin-forums", "checkin-cloud", "checkin-os"] as const) {
    get(field).disabled = !loaded || pending;
  }
  get("checkin-enabled").disabled = !loaded || (loaded.canEnable === false && !loaded.enabled);
  for (const game of (Object.keys(checkinCloudGames) as (keyof typeof checkinCloudGames)[])) {
    get(("checkin-cloud-" + game) as `checkin-cloud-${keyof typeof checkinCloudGames}`).disabled = !loaded || (!loaded.cloudBound[game] && !loaded.cloud[game]);
  }
  const patch = checkinPatch();
  get("checkin-settings-save").disabled = !loaded || pending ||
    (checkinSwitches.every(key => patch[key] === loaded[key]) && sameFlags(patch.games, loaded.games) &&
      sameFlags(patch.cloud, loaded.cloud) && patch.forums.length === loaded.forums.length && patch.forums.every(id => loaded.forums.includes(id)) &&
      patch.osEnabled === loaded.osEnabled && sameFlags(patch.os, loaded.os));
  get("checkin-settings-form").setAttribute("aria-busy", String(pending));
}

function renderCheckinSettings(data: CheckinSettings) {
  for (const key of checkinSwitches) get(("checkin-" + key) as `checkin-${typeof checkinSwitches[number]}`).checked = data[key];
  for (const input of get("checkin-games").querySelectorAll("input")) input.checked = data.games[input.value as keyof typeof data.games] === true;
  for (const input of get("checkin-forums").querySelectorAll("input")) input.checked = data.forums.includes(Number(input.value));
  for (const game of (Object.keys(checkinCloudGames) as (keyof typeof checkinCloudGames)[])) get(("checkin-cloud-" + game) as `checkin-cloud-${keyof typeof checkinCloudGames}`).checked = data.cloud[game];
  get("checkin-os-enabled").checked = data.osEnabled;
  for (const input of get("checkin-os").querySelectorAll<HTMLInputElement>('input[name="os"]')) input.checked = data.os[input.value as keyof typeof data.os];
  const messages = [];
  if (data.cnEnabled === false) messages.push($t("web.miyoushe.app.text_608e95b98c"));
  if (data.canEnable === false && !data.enabled) messages.push($t("web.miyoushe.app.text_516bf8f90f"));
  const unbound = Object.entries(checkinCloudGames).filter(([game]) => !data.cloudBound[game as keyof typeof data.cloudBound]).map(([, label]) => label);
  if (unbound.length) messages.push($t("web.miyoushe.app.text_7051d74063", { "value1": unbound.join("、") }));
  if (!data.osBound) messages.push($t("web.miyoushe.app.text_3e985d9cd1"));
  return messages.join(" ");
}

async function updateProfileSettings<Key extends SettingsKey>(editor: ProfileEditor<Key>, patch?: SettingsPatch[Key]) {
  if (editor.active || get(editor.key + "-settings").hidden) return;
  const active = editor.active = new AbortController();
  const deadline = AbortSignal.any([active.signal, AbortSignal.timeout(20_000)]);
  const notice = get(editor.key + "-settings-note");
  editor.buttons();
  notice.classList.remove("error");
  notice.textContent = patch ? $t("web.miyoushe.app.text_f1d891498e") : $t("web.miyoushe.app.text_9ee6956371");
  try {
    const response = await request("api/" + editor.key + "-settings", patch ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch), signal: deadline,
    } : { signal: deadline });
    if (active.signal.aborted) return;
    if (response.status === 401) {
      showLogin($t("web.miyoushe.app.text_519e8af82e", { "loginHelp": loginHelp }), true);
      return;
    }
    if (!response.ok) throw new Error(await planFailure(response));
    const data = await response.json() as SettingsByKey[Key];
    if (active.signal.aborted) return;
    const previous = editor.data;
    editor.data = data;
    const message = editor.render(data);
    if (patch) {
      // Both sections use the same profile revision. Keep the other section's
      // unchanged settings and any unsaved edits after our own successful write.
      for (const other of profileEditors) if (other !== editor && other.data?.revision === patch.revision) {
        other.data = { ...other.data!, revision: data.revision };
      }
      if (editor === checkin && previous?.enabled !== data.enabled) {
        const schedule = get("today-schedule");
        schedule.textContent = data.enabled ? $t("web.miyoushe.app.text_8b743966c1") : $t("web.miyoushe.app.text_38dd03105c");
        schedule.hidden = false;
      }
    }
    notice.textContent = patch ? [$t("web.miyoushe.app.text_2717052f81"), message].filter(Boolean).join(" ") : message;
  } catch (error) {
    if (active.signal.aborted) return;
    notice.classList.add("error");
    notice.textContent = error instanceof TypeError || deadline.aborted
      ? (patch ? $t("web.miyoushe.app.text_001105b530") : $t("web.miyoushe.app.text_25e05b9b37"))
      : (error as Error).message;
  } finally {
    if (editor.active === active) {
      editor.active = null;
      editor.buttons();
    }
  }
}

function showNotice(message: string, error = false) {
  const notice = get("notice");
  notice.textContent = message;
  notice.hidden = !message;
  notice.classList.toggle("error", error);
}

function scheduleText(schedule: MiyousheOverview["todaySchedule"]) {
  if (!schedule) return "";
  if (!schedule.enabled) return $t("web.miyoushe.app.text_38dd03105c");
  if (!schedule.time) return $t("web.miyoushe.app.text_7215d99903");
  const status = schedule.running ? $t("web.miyoushe.app.text_8f38fd93b5") :
    schedule.done ? (schedule.ok ? $t("web.miyoushe.app.text_f28461bb49") : $t("web.miyoushe.app.text_94e30b1b38")) : $t("web.miyoushe.app.text_4f021f5912");
  return $t("web.miyoushe.app.text_cede4a4c76", { "time": schedule.time, "status": status });
}

function missionRow(item: Mission) {
  const row = add("li", "mission-row", "");
  const status = item.isGetAward === true ? $t("web.miyoushe.app.text_a6e657667d") :
    item.isGetAward === false ? (
      Number.isSafeInteger(item.happenedTimes) && Number.isSafeInteger(item.threshold) &&
        item.happenedTimes! < item.threshold! ? $t("web.miyoushe.app.text_7f750504c5") : $t("web.miyoushe.app.text_7dcad57208")
    ) : $t("web.miyoushe.app.text_93e474c68e");
  const progress = Number.isSafeInteger(item.happenedTimes) ?
    (Number.isSafeInteger(item.threshold) ? `${item.happenedTimes} / ${item.threshold}` : $t("web.miyoushe.app.text_58d218f90f", { "happenedTimes": item.happenedTimes })) : "";
  row.append(add("span", "", item.label), add("span", item.isGetAward === true ? "complete" : "muted",
    [progress, status].filter(Boolean).join(" · ")));
  return row;
}

function showOverview(data: Overview) {
  const { account, displayName, missions, missionError, todaySchedule, profileId, expiresAt } = data;
  const profile = $t("web.miyoushe.app.text_3f6fdc79bb", { "profileId": profileId });
  get("profile").textContent = profile;
  get("profile-name").textContent = displayName || profile;
  get("session-expiry").textContent = Number.isSafeInteger(expiresAt) ? $t("web.miyoushe.app.text_f70036fba2", { "value1": expiry.format(expiresAt) }) : "";
  clearTimeout(expiryTimer);
  if (Number.isSafeInteger(expiresAt)) {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      showLogin($t("web.miyoushe.app.text_519e8af82e", { "loginHelp": loginHelp }), true);
      return;
    }
    if (remaining <= 2_147_483_647) {
      expiryTimer = setTimeout(() => showLogin($t("web.miyoushe.app.text_519e8af82e", { "loginHelp": loginHelp }), true), remaining);
    }
  }
  get("account-state").textContent = `${account.loggedIn ? $t("web.miyoushe.app.text_0a01eee1cd") : $t("web.miyoushe.app.text_c1f6583730")} · ${account.deviceBound ? $t("web.miyoushe.app.text_2d07e3bb61") : $t("web.miyoushe.app.text_2fbfcc023e")}`;
  get("today-schedule").textContent = scheduleText(todaySchedule);
  get("today-schedule").hidden = !todaySchedule;
  get("roles-empty").hidden = account.roles.length > 0;
  const roles = account.roles.map(role => {
    const label = games[role.game] ?? role.game;
    const row = add("li", "role-row", "");
    row.append(add("span", "", role.nickname ? `${label} · ${role.nickname}` : label), add("span", "muted", `UID ${role.uid}`));
    return row;
  });
  get("roles").replaceChildren(...roles);
  get("balance").textContent = point(missions?.balance);
  get("received").textContent = point(missions?.received);
  get("today-total").textContent = point(missions?.todayTotal);
  const remaining = missions?.remaining;
  const remainingLine = get("missions-remaining");
  remainingLine.hidden = remaining === undefined;
  remainingLine.textContent = remaining === undefined ? "" : $t("web.miyoushe.app.text_c507f0e357", { "value1": point(remaining) });
  get("missions-empty").hidden = Boolean(missions?.items.length);
  get("missions-empty").textContent = missionError || (missions ? $t("web.miyoushe.app.text_973ae59458") : $t("web.miyoushe.app.text_92c7816b49"));
  get("missions").replaceChildren(...(missions?.items.map(missionRow) ?? []));
  get("login").hidden = true;
  get("dashboard").hidden = false;
  get("clock").textContent = clock.format();
}

function switchTab(next: Tab) {
  tab = next;
  if (tab !== "overview") clearTimeout(manualCheckin.timer);
  if (tab !== "plans") clearTimeout(plans.timer);
  for (const name of ["overview", "shop", "trackers", "plans"]) {
    get(name + "-view").hidden = name !== tab;
    get("tab-" + name).setAttribute("aria-pressed", String(name === tab));
  }
  showNotice("");
}

function resetShop() {
  shop.catalogRequest?.abort();
  shop.detailRequest?.abort();
  Object.assign(shop, { data: null, game: "", page: 1, nowOffset: 0, catalogRequest: null, detailRequest: null });
  get("shop-goods").replaceChildren();
  get("shop-note").textContent = "";
  get("shop-game").replaceChildren(new Option($t("web.miyoushe.app.text_207bb971b8"), ""));
  get("shop-status").value = "all";
  get("shop-search").value = "";
  get("shop-pagination").hidden = true;
  get("shop-detail").close();
  get("shop-detail-content").replaceChildren();
  plans.scope++;
  clearTimeout(plans.timer);
  plans.data = null;
  plans.loading = null;
  plans.older.clear();
  plans.olderCursor = undefined;
  plans.loadingOlder = false;
  plans.activeForm = null;
  plans.actions.clear();
  plans.intents.clear();
  get("plans-note").textContent = "";
  get("shop-plans").replaceChildren();
  trackers.generation++;
  trackers.targets?.abort();
  trackers.loading?.abort();
  trackers.loading = null;
  trackers.data = null;
  get("tracker-dialog").close();
  get("tracker-open").disabled = true;
  get("trackers-note").textContent = "";
  get("shop-trackers").replaceChildren();
}

function shopTime(milliseconds: number | null | undefined) {
  return Number.isSafeInteger(milliseconds) ? shopClock.format(milliseconds!) + $t("web.miyoushe.app.text_5eb76ad884") : $t("web.miyoushe.app.text_4d8c1c5b42");
}

function tickShop() {
  const now = Date.now() + shop.nowOffset;
  for (const line of document.querySelectorAll<HTMLElement>("[data-shop-deadline]")) {
    const seconds = Math.ceil((Number(line.dataset.shopDeadline) - now) / 1000);
    if (seconds <= 0) {
      line.textContent = $t("web.miyoushe.app.text_fd7147a900");
      continue;
    }
    const days = Math.floor(seconds / 86400);
    const time = [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
      .map(value => String(value).padStart(2, "0")).join(":");
    line.textContent = $t("web.miyoushe.app.text_d6047e58be") + (days ? days + $t("web.miyoushe.app.text_5ab7e0f9b7") : "") + time;
  }
}

function shopIcon(good: Good) {
  const source = good.icon;
  if (typeof source !== "string" ||
      !/^https:\/\/bbs-static\.miyoushe\.com\/static\/[\w/-]+\.(?:png|jpe?g|webp)$/iu.test(source)) return null;
  const img = add("img", "shop-icon", "");
  img.alt = "";
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", () => img.remove(), { once: true });
  img.src = source;
  return img;
}

function shopFacts(good: Good, detail = false, accountQuota?: AccountQuota) {
  const facts = add("dl", "shop-facts", "");
  function item(label: string, value: string) { facts.append(add("dt", "", label), add("dd", "", value)); }
  item($t("web.miyoushe.app.text_6063416555"), good.unlimited ? $t("web.miyoushe.app.text_6cf3bcae82") : good.stock == null ? $t("web.miyoushe.app.text_4d8c1c5b42") : point(good.stock));
  if (good.opensAt) {
    item($t("web.miyoushe.app.text_73199769b3"), shopTime(good.opensAt));
    item($t("web.miyoushe.app.text_e102a5f8bf"), good.nextStock == null ? $t("web.miyoushe.app.text_4d8c1c5b42") : point(good.nextStock));
  }
  if (detail && good.endsAt) item($t("web.miyoushe.app.text_f502764499"), shopTime(good.endsAt));
  if (good.accountLimit! > 0) item($t("web.miyoushe.app.text_65fde51fff"), accountQuota ? `${point(accountQuota.used)}/${point(accountQuota.limit)}` : point(good.accountLimit));
  if (detail && good.roleLimit! > 0) item($t("web.miyoushe.app.text_29686e0d06"), point(good.roleLimit));
  return facts;
}

function statusBadge(status: string) {
  const known = Object.hasOwn(shopStatuses, status) ? status as keyof typeof shopStatuses : "unknown";
  return add("span", "shop-badge " + known, shopStatuses[known]);
}

function renderGoods() {
  if (!shop.data) return;
  const filter = get("shop-status").value;
  const term = get("shop-search").value.trim().toLocaleLowerCase("zh-CN");
  const goods = shop.data.goods.filter(good =>
    (filter === "all" || good.status === filter) && good.name.toLocaleLowerCase("zh-CN").includes(term));
  const cards = goods.map(good => {
    const card = add("article", "good", "");
    const visual = add("div", "good-visual", "");
    const image = shopIcon(good);
    if (image) visual.append(image);
    visual.append(statusBadge(good.status));
    const content = add("div", "good-body", "");
    const action = add("button", "secondary good-action", $t("web.miyoushe.app.text_faa93dadc4"));
    action.type = "button";
    action.addEventListener("click", () => void openDetail(good.id));
    content.append(add("h3", "", good.name), add("p", "shop-price", point(good.price) + $t("web.miyoushe.app.text_1125a6cf36")), shopFacts(good));
    if (good.opensAt) {
      const countdown = add("p", "countdown", "");
      countdown.dataset.shopDeadline = String(good.opensAt);
      content.append(countdown);
    }
    content.append(action);
    card.append(visual, content);
    return card;
  });
  get("shop-goods").replaceChildren(...(cards.length ? cards : [add("p", "shop-empty", $t("web.miyoushe.app.text_66f000ba96"))]));
  tickShop();
}

function catalogControls(data: CatalogData) {
  const game = get("shop-game");
  game.replaceChildren(new Option($t("web.miyoushe.app.text_207bb971b8"), ""), ...data.games.map(item => new Option(item.name, item.key)));
  if (![...game.options].some(option => option.value === shop.game)) game.append(new Option(shop.game, shop.game));
  game.value = shop.game;
  get("shop-page").textContent = data.page + " / " + data.totalPages;
  get("shop-previous").disabled = data.page <= 1;
  get("shop-next").disabled = data.page >= data.totalPages;
  get("shop-pagination").hidden = false;
}

function shopProblem(response: Response, detail = false) {
  if (response.status === 429) return $t("web.miyoushe.app.text_6a6523693b");
  if (detail && response.status === 404) return $t("web.miyoushe.app.text_d80df97840");
  return detail ? $t("web.miyoushe.app.text_c909d308f2") : $t("web.miyoushe.app.text_f94620a9c5");
}

async function shopRequest(path: string, controller: AbortController) {
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
  return request(path, { signal });
}

async function loadCatalog(page = shop.page, game = shop.game) {
  shop.catalogRequest?.abort();
  const controller = new AbortController();
  shop.catalogRequest = controller;
  get("shop-note").textContent = $t("web.miyoushe.app.text_7a47d8c9b7");
  try {
    const query = new URLSearchParams({ page: String(page), game });
    const response = await shopRequest("api/catalog?" + query, controller);
    if (controller.signal.aborted) return;
    if (response.status === 401 || response.status === 403) {
      showLogin(loginHelp, true);
      return;
    }
    if (!response.ok) throw new Error(shopProblem(response));
    const data = await response.json() as CatalogData;
    if (controller.signal.aborted) return;
    shop.data = data;
    shop.page = data.page;
    shop.game = game;
    shop.nowOffset = data.now - Date.now();
    catalogControls(data);
    renderGoods();
    get("shop-note").textContent = point(data.total) + $t("web.miyoushe.app.text_1f1c524ab1") + data.page + $t("web.miyoushe.app.text_85ca81cf6a");
  } catch (error) {
    if (controller.signal.aborted) return;
    const message = error instanceof Error && error.name === "Error" ? error.message : $t("web.miyoushe.app.text_f94620a9c5");
    get("shop-note").textContent = message + (shop.data ? $t("web.miyoushe.app.text_c05cdbeca7") : "");
    get("shop-game").value = shop.game;
  } finally {
    if (shop.catalogRequest === controller) shop.catalogRequest = null;
  }
}

function communityAccountGood(good: Good) {
  return good.type === 2 && good.game === "bbs" && good.gameBiz === "bbs_cn";
}

function detailContent({ good, roles, roleError, addresses, accountQuota }: Detail) {
  const blocks: HTMLElement[] = [add("h3", "", good.name), statusBadge(good.status),
    add("p", "shop-price", point(good.price) + $t("web.miyoushe.app.text_1125a6cf36")), shopFacts(good, true, accountQuota),
    add("h4", "", $t("web.miyoushe.app.text_13a728b0d5")), add("p", "detail-copy", good.requirements || $t("web.miyoushe.app.text_c2c7286658"))];
  if (good.type === 1) blocks.push(add("p", "muted", $t("web.miyoushe.app.text_4d0927a238")));
  if (good.type === 2 && !communityAccountGood(good)) {
    if (roleError || !roles.length) {
      blocks.push(add("h4", "", $t("web.miyoushe.app.text_1fc4257e81")), add("p", "muted", roleError || $t("web.miyoushe.app.text_4db1e17357")));
    } else if (!plans.data?.canSubmit || (!plans.intents.has(good.id) && !["available", "scheduled"].includes(good.status))) {
      blocks.push(add("h4", "", $t("web.miyoushe.app.text_1fc4257e81")));
      const list = add("ul", "rows", "");
      for (const role of roles) {
        const row = add("li", "role-row", "");
        row.append(add("span", "", roleLabel(role)), add("span", "muted", "UID " + role.uid));
        list.append(row);
      }
      blocks.push(list, add("p", "muted", $t("web.miyoushe.app.text_0b09403966")));
    }
  }
  const tracked = trackerProduct(good);
  if (tracked && plans.data?.canSubmit) {
    const track = add("button", "secondary", $t("web.miyoushe.app.text_bc787548e0"));
    track.type = "button";
    track.addEventListener("click", () => {
      get("shop-detail").close();
      openTracker(tracked);
    });
    blocks.push(track);
  }
  blocks.push(reservationForm(good, roles, addresses, accountQuota));
  return blocks;
}

async function openDetail(id: string) {
  shop.detailRequest?.abort();
  const controller = new AbortController();
  shop.detailRequest = controller;
  const dialog = get("shop-detail"), content = get("shop-detail-content");
  plans.activeForm = null;
  content.replaceChildren(add("p", "muted", $t("web.miyoushe.app.text_4775ca3ef1")));
  if (!dialog.open) dialog.showModal();
  try {
    const [response] = await Promise.all([shopRequest("api/goods/" + encodeURIComponent(id), controller), loadPlans()]);
    if (controller.signal.aborted) return;
    if (response.status === 401 || response.status === 403) {
      showLogin(loginHelp, true);
      return;
    }
    if (!response.ok) {
      content.replaceChildren(add("p", "error", shopProblem(response, true)));
      return;
    }
    const data = await response.json() as Detail;
    if (!controller.signal.aborted) content.replaceChildren(...detailContent(data));
  } catch {
    if (!controller.signal.aborted) content.replaceChildren(add("p", "error", $t("web.miyoushe.app.text_c909d308f2")));
  } finally {
    if (shop.detailRequest === controller) shop.detailRequest = null;
  }
}

function roleLabel(role: Role) {
  return [role.nickname || $t("web.miyoushe.app.text_c47b54e84e"), role.regionName || $t("web.miyoushe.app.text_d27d31175b"), role.level ? "Lv." + role.level : ""]
    .filter(Boolean).join(" · ");
}

function planNote(message: string, error = false) {
  const notice = get("plans-note");
  notice.textContent = message;
  notice.classList.toggle("error", error);
}

function planRow(plan: Plan) {
  const row = add("article", "plan-row", "");
  const copy = add("div", "plan-copy", "");
  const status = Object.hasOwn(planStatus, plan.status) ? plan.status : "unknown";
  const verification = plan.verification;
  const destination = verification?.expiresAt! > Date.now() && typeof verification!.link === "string" ? URL.parse(verification!.link) : null;
  const canOpenVerification = destination && (destination.protocol === "https:" ||
    (destination.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(destination.hostname)));
  copy.append(add("span", "shop-badge " + status, canOpenVerification ? $t("web.miyoushe.app.text_dcb1e1edd5") : planStatus[status]), add("h3", "", plan.goodsName),
    add("p", "muted", $t("web.miyoushe.app.text_bc36d75f7e") + plan.profileId + " · " + point(plan.price) + $t("web.miyoushe.app.text_b31eca7947") + shopTime(plan.opensAt)));
  if (plan.role) copy.append(add("p", "muted", $t("web.miyoushe.app.text_82465ab5df") + plan.role.uid + " · " + (plan.role.regionName || $t("web.miyoushe.app.text_d27d31175b"))));
  if (plan.addressLabel) copy.append(add("p", "muted", $t("web.miyoushe.app.text_169967135e") + plan.addressLabel));
  if (canOpenVerification) {
    const prompt = add("div", "plan-verification", "");
    const link = add("a", "secondary", $t("web.miyoushe.app.text_850b074f6c"));
    link.href = destination.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    prompt.append(link, add("p", "muted", $t("web.miyoushe.app.text_3e5cd6e6dd") + shopTime(verification!.expiresAt)));
    copy.append(prompt);
  } else if (plan.message) copy.append(add("p", "", plan.message));
  row.append(copy);
  if (!/^[a-f0-9]{12}$/u.test(plan.id)) return row;
  const actions = add("div", "plan-actions", "");
  function action(label: string, operation: "cancel" | "resolve", body: object, prompt: string) {
    const button = add("button", "secondary", label);
    button.type = "button";
    button.disabled = plans.actions.has(plan.id);
    button.addEventListener("click", () => {
      if (!plans.actions.has(plan.id) && window.confirm(prompt)) void changePlan(plan.id, operation, body);
    });
    actions.append(button);
  }
  if (plan.status === "scheduled" || plan.status === "preparing") {
    action($t("web.miyoushe.app.text_0afc4fe3d3"), "cancel", {}, $t("web.miyoushe.app.text_4a784574eb") + plan.goodsName + $t("web.miyoushe.app.text_6b8cd4099c"));
  } else if (plan.status === "unknown") {
    for (const [label, redeemed] of [[$t("web.miyoushe.app.text_9159f80b11"), true], [$t("web.miyoushe.app.text_97fc2497b5"), false]] as const) {
      action(label, "resolve", { redeemed }, $t("web.miyoushe.app.text_752d40359f") + plan.goodsName + $t("web.miyoushe.app.text_a3793d9bce") +
        (redeemed ? $t("web.miyoushe.app.text_5215e2c23e") : $t("web.miyoushe.app.text_0d6cc8fcbb")));
    }
  }
  if (actions.children.length) row.append(actions);
  return row;
}

function renderPlans() {
  if (!plans.data) return;
  const combined = new Map(plans.older);
  for (const plan of plans.data.plans) combined.set(plan.id, plan);
  const rows: HTMLElement[] = [...combined.values()]
    .sort((a, b) => b.createdAt - a.createdAt).map(planRow);
  const cursor = plans.olderCursor === undefined ? plans.data.older : plans.olderCursor;
  if (cursor) {
    const more = add("button", "secondary", plans.loadingOlder ? $t("web.miyoushe.app.text_86b6d0d630") : $t("web.miyoushe.app.text_a403e7c5f6"));
    more.type = "button";
    more.disabled = plans.loadingOlder;
    more.addEventListener("click", () => void loadOlderPlans(cursor));
    rows.push(more);
  }
  get("shop-plans").replaceChildren(...(rows.length ? rows : [add("p", "shop-empty", $t("web.miyoushe.app.text_6de1abf37c"))]));
}

async function loadOlderPlans(cursor: string) {
  if (plans.loadingOlder) return;
  const scope = plans.scope;
  plans.loadingOlder = true;
  renderPlans();
  try {
    const response = await request("api/plans?" + new URLSearchParams({ before: cursor }));
    if (scope !== plans.scope) return;
    if (response.status === 401 || response.status === 403) {
      showLogin(loginHelp, true);
      return;
    }
    if (!response.ok) throw new Error($t("web.miyoushe.app.text_6aa27f14bf"));
    const data = await response.json() as PlanData;
    if (scope !== plans.scope) return;
    for (const plan of data.plans) plans.older.set(plan.id, plan);
    plans.olderCursor = data.older ?? null;
  } catch {
    if (scope === plans.scope) planNote($t("web.miyoushe.app.text_8054c3e76f"), true);
  } finally {
    if (scope === plans.scope) {
      plans.loadingOlder = false;
      renderPlans();
    }
  }
}

function loadPlans(background = false) {
  if (plans.loading) return plans.loading;
  clearTimeout(plans.timer);
  const scope = plans.scope;
  const revision = plans.revision;
  if (!background) planNote($t("web.miyoushe.app.text_665482660c"));
  plans.loading = (async () => {
    try {
      const response = await request("api/plans");
      if (scope !== plans.scope) return;
      if (response.status === 401 || response.status === 403) {
        showLogin(loginHelp, true);
        return;
      }
      if (!response.ok) throw new Error($t("web.miyoushe.app.text_6aa27f14bf"));
      const data = await response.json() as PlanData;
      if (scope !== plans.scope || revision !== plans.revision) return;
      const rowsChanged = !plans.data || plans.data.older !== data.older || JSON.stringify(plans.data.plans) !== JSON.stringify(data.plans);
      if (plans.loadingOlder || plans.olderCursor !== undefined) {
        const current = new Set(data.plans.map(plan => plan.id));
        for (const plan of plans.data?.plans ?? []) {
          if (!current.has(plan.id) && ["succeeded", "failed", "cancelled", "missed"].includes(plan.status)) plans.older.set(plan.id, plan);
        }
      }
      const exchanged = plans.data && data.plans.some(plan => plan.status === "succeeded" &&
        plans.data!.plans.some(previous => previous.id === plan.id && previous.status !== "succeeded"));
      plans.data = data;
      if (rowsChanged) renderPlans();
      if (exchanged) void refresh();
      const messages = [];
      if (!data.canSubmit) messages.push($t("web.miyoushe.app.text_bba5b8d55c"));
      if (plans.intents.size) messages.push($t("web.miyoushe.app.text_cac49881b4"));
      planNote(messages.join(" "));
    } catch {
      if (scope !== plans.scope || revision !== plans.revision) return;
      if (plans.data) plans.data = { ...plans.data, canSubmit: false };
      planNote(plans.data ? $t("web.miyoushe.app.text_51e8e9cd2b") : $t("web.miyoushe.app.text_8409d00a2e"), true);
    } finally {
      if (scope === plans.scope) {
        plans.loading = null;
        if (tab === "plans" && !document.hidden && !get("dashboard").hidden) {
          const delay = plans.data?.plans.some(plan => plan.verificationPending) ? 1_000 : 3_000;
          plans.timer = setTimeout(() => {
            if (tab === "plans" && !document.hidden) void loadPlans(true);
          }, delay);
        }
      }
    }
  })();
  return plans.loading;
}

async function postPlan(path: string, body: object) {
  return request(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

async function planFailure(response: Response) {
  const data = await response.json().catch(() => null) as { message?: unknown } | null;
  if (typeof data?.message === "string" && data.message.length <= 200) return data.message;
  if (response.status === 409) return $t("web.miyoushe.app.text_8d5a34f710");
  if (response.status === 404) return $t("web.miyoushe.app.text_efa738818a");
  return $t("web.miyoushe.app.text_514f2b69e4");
}

async function trackingResponse<Data>(response: Response): Promise<Data> {
  if (response.status === 401) {
    showLogin($t("web.miyoushe.app.text_519e8af82e", { "loginHelp": loginHelp }), true);
    throw new Error($t("web.miyoushe.app.text_4150f6e59b"));
  }
  if (!response.ok) throw new Error(await planFailure(response));
  return response.json() as Promise<Data>;
}

async function loadTrackers() {
  if (trackers.loading) return;
  const generation = trackers.generation;
  const note = get("trackers-note");
  const active = new AbortController();
  trackers.loading = active;
  try {
    const response = await request("api/trackers", { signal: AbortSignal.any([active.signal, AbortSignal.timeout(20_000)]) });
    if (trackers.loading !== active) return;
    const data = await trackingResponse<TrackerData>(response);
    if (trackers.generation !== generation) return;
    get("tracker-open").disabled = !data.canTrack;
    note.textContent = data.canTrack ? "" : $t("web.miyoushe.app.text_6983798f9b");
    const previous = trackers.data;
    if (previous?.canTrack === data.canTrack && JSON.stringify(previous.trackers) === JSON.stringify(data.trackers)) return;
    trackers.data = data;
    const rows = data.trackers.map(rule => {
      const row = add("article", "plan-row", "");
      const copy = add("div", "plan-copy", "");
      const actions = add("div", "plan-actions", "");
      const group = (Object.hasOwn(trackGames, rule.game) && trackGames[rule.game as keyof typeof trackGames]) || rule.game || $t("web.miyoushe.app.text_c293bae3f6");
      const item = rule.itemType === 1 ? $t("web.miyoushe.app.text_f01d5655c1") : rule.itemType === 2 ? $t("web.miyoushe.app.text_f7530fe129") : $t("web.miyoushe.app.text_6a319c32f4");
      if (rule.migrationBlocked) {
        copy.append(add("h3", "", `${group} · ${item}`), add("p", "muted", rule.message),
          add("p", "muted", $t("web.miyoushe.app.text_3844ddd945", { "value1": point(rule.spent), "value2": point(rule.held) })));
        row.append(copy);
        return row;
      }
      const selection = rule.mode === "goods" ? (rule.names.length ? rule.names : rule.goodsIds).join("、")
        : rule.keywords.join("、") || $t("web.miyoushe.app.text_207bb971b8");
      const limit = rule.spendLimit === null ? $t("web.miyoushe.app.text_f203d577d1") : point(rule.spendLimit);
      const destination = rule.role ? `UID ${rule.role.uid} · ${rule.role.regionName || $t("web.miyoushe.app.text_d27d31175b")}` : rule.addressLabel;
      copy.append(add("h3", "", `${group} · ${item}`), add("p", "", selection),
        add("p", "muted", $t("web.miyoushe.app.text_7a118b0f7c", { "destination": destination, "value2": point(rule.spent), "limit": limit, "value4": point(rule.held) })),
        add("p", "muted", `${rule.enabled ? $t("web.miyoushe.app.text_85168c4cbd") : $t("web.miyoushe.app.text_eb0c326b60")} · ${rule.message}`));
      if (rule.enabled && Number.isSafeInteger(rule.nextOpenAt)) copy.append(add("p", "muted", $t("web.miyoushe.app.text_c82733b9ff", { "value1": shopTime(rule.nextOpenAt) })));
      if (rule.enabled || data.canTrack) {
        const toggle = add("button", "secondary", rule.enabled ? $t("web.miyoushe.app.text_8d12fc0d4e") : rule.needsConfirmation ? $t("web.miyoushe.app.text_bfb81b90be") : $t("web.miyoushe.app.text_e0534b8a4e"));
        toggle.type = "button";
        toggle.addEventListener("click", async () => {
          const action = rule.enabled ? "pause" : "resume";
          if (!rule.enabled && !window.confirm($t("web.miyoushe.app.text_93e7d454a6", { "group": group, "selection": selection, "limit": limit }))) return;
          toggle.disabled = true;
          try {
            await trackingResponse(await postPlan(`api/trackers/${rule.id}/${action}`, { confirmed: !rule.enabled }));
            if (trackers.generation === generation) await loadTrackers();
          } catch (error) {
            if (trackers.generation === generation) note.textContent = (error as Error).message;
          } finally { toggle.disabled = false; }
        });
        actions.append(toggle);
      }
      row.append(copy, actions);
      return row;
    });
    get("shop-trackers").replaceChildren(...(rows.length ? rows : [add("p", "shop-empty", $t("web.miyoushe.app.text_53930623d3"))]));
  } catch (error) {
    if (trackers.generation === generation) note.textContent = (error as Error).message;
  } finally {
    if (trackers.loading === active) trackers.loading = null;
  }
}

function trackerMode() {
  const form = get("tracker-form").elements;
  const specific = form.mode.value === "goods";
  get("tracker-keywords").hidden = specific;
  get("tracker-goods").hidden = !specific;
  get("tracker-follow").hidden = !specific;
  form.goodsIds.required = specific;
}

async function loadTrackerTargets() {
  trackers.targets?.abort();
  const controller = trackers.targets = new AbortController();
  const form = get("tracker-form").elements;
  const note = get("tracker-form-note");
  const submit = get("tracker-submit");
  const query = new URLSearchParams({ game: form.game.value, itemType: form.itemType.value });
  submit.disabled = true;
  form.confirmed.checked = false;
  form.destination.replaceChildren();
  note.textContent = $t("web.miyoushe.app.text_3272da2758");
  try {
    const data = await trackingResponse<TrackerTargets>(await request("api/tracking-targets?" + query, { signal: controller.signal }));
    if (controller.signal.aborted) return;
    const options = data.items.map(item => data.type === "role"
      ? new Option(`UID ${(item as TrackerRole).uid} · ${(item as TrackerRole).regionName || $t("web.miyoushe.app.text_d27d31175b")}`, (item as TrackerRole).uid)
      : new Option((item as TrackerAddress).label || $t("web.miyoushe.app.text_6fa472631c"), (item as TrackerAddress).id));
    form.destination.replaceChildren(...options);
    submit.disabled = !options.length;
    note.textContent = options.length ? "" : $t("web.miyoushe.app.text_284ea2cab8");
  } catch (error) {
    if (!controller.signal.aborted) note.textContent = (error as Error).message;
  }
}

function trackerProduct(good: Good): TrackerProduct | undefined {
  if (good.type !== 1 && good.type !== 2) return;
  const business = Object.keys(trackGames).find(game => game !== "bbs" && good.gameBiz === `${game}_cn`);
  const game = good.game || business;
  if (!game || game === "all" || !/^[a-zA-Z0-9_]{1,32}$/u.test(game) || good.type === 2 && game !== business) return;
  return { id: good.id, game, type: good.type };
}

function openTracker(product?: TrackerProduct) {
  const form = get("tracker-form");
  form.reset();
  if (product) form.elements.itemType.value = String(product.type);
  trackerGameOptions(product?.game ?? shop.game, product?.type === 1);
  if (product) {
    form.elements.mode.value = "goods";
    form.elements.goodsIds.value = product.id;
  }
  trackerMode();
  get("tracker-dialog").showModal();
  void loadTrackerTargets();
}

function trackerGameOptions(preferred: string, includeProductGame = false) {
  const form = get("tracker-form").elements;
  const physical = form.itemType.value === "1";
  const entries = Object.entries(trackGames).filter(([key]) => physical || key !== "bbs");
  if (physical) {
    for (const game of shop.data?.games ?? []) {
      if (/^[a-zA-Z0-9_]{1,32}$/u.test(game.key) && game.key !== "all" && !entries.some(([key]) => key === game.key)) {
        entries.push([game.key, game.name]);
      }
    }
  }
  if (includeProductGame && !entries.some(([key]) => key === preferred)) entries.push([preferred, preferred]);
  form.game.replaceChildren(...entries.map(([key, name]) => new Option(name, key)));
  if (entries.some(([key]) => key === preferred)) form.game.value = preferred;
}

async function saveTracker(event: SubmitEvent) {
  event.preventDefault();
  const submit = get("tracker-submit");
  if (submit.disabled) return;
  const form = (event.target as TrackerForm).elements;
  const generation = trackers.generation;
  const split = (field: HTMLInputElement) => field.value.split(/[,，]/u).map(item => item.trim()).filter(Boolean);
  const amount = (field: HTMLInputElement) => field.value === "" ? null : Number(field.value);
  submit.disabled = true;
  try {
    await trackingResponse(await postPlan("api/trackers", {
      confirmed: form.confirmed.checked, game: form.game.value, itemType: Number(form.itemType.value), mode: form.mode.value,
      goodsIds: form.mode.value === "goods" ? split(form.goodsIds) : [],
      keywords: form.mode.value === "category" ? split(form.keywords) : [],
      followSameName: form.followSameName.checked, addressId: form.itemType.value === "1" ? form.destination.value : "",
      maxPrice: amount(form.maxPrice), spendLimit: amount(form.spendLimit),
      pollMinutes: Number(form.pollMinutes.value), leadSeconds: Number(form.leadSeconds.value), intervalMs: Number(form.intervalMs.value),
    }));
    if (generation !== trackers.generation) return;
    get("tracker-dialog").close();
    switchTab("trackers");
    await loadTrackers();
  } catch (error) {
    if (generation === trackers.generation) get("tracker-form-note").textContent = (error as Error).message;
  } finally {
    if (generation === trackers.generation && get("tracker-dialog").open) submit.disabled = false;
  }
}

async function changePlan(id: string, action: "cancel" | "resolve", body: object) {
  const scope = plans.scope;
  plans.actions.add(id);
  renderPlans();
  try {
    const response = await postPlan("api/plans/" + id + "/" + action, body);
    if (scope !== plans.scope) return;
    if (response.status === 401 || response.status === 403) {
      showLogin(loginHelp, true);
      return;
    }
    if (!response.ok) {
      const problem = await planFailure(response);
      if (scope === plans.scope) planNote(problem, true);
      return;
    }
    const plan = await response.json() as Plan;
    if (scope !== plans.scope) return;
    plans.revision++;
    if (plans.data) {
      plans.data = { ...plans.data, plans: plans.data.plans.map(row => row.id === plan.id ? plan : row) };
      renderPlans();
    }
    planNote(action === "cancel" ? $t("web.miyoushe.app.text_a6e4609f7d") : $t("web.miyoushe.app.text_14f10fbe93"));
  } catch {
    if (scope === plans.scope) planNote($t("web.miyoushe.app.text_430e10a66b"), true);
  } finally {
    if (scope === plans.scope) {
      plans.actions.delete(id);
      renderPlans();
    }
  }
}

function reservationForm(good: Good, roles: readonly Role[], addresses: readonly Address[] | undefined, accountQuota?: AccountQuota) {
  const panel = add("form", "reservation-form", "");
  if (!plans.data?.canSubmit) {
    panel.append(add("p", "muted", plans.data ? $t("web.miyoushe.app.text_bba5b8d55c") : $t("web.miyoushe.app.text_983d92d87c")));
    return panel;
  }
  const saved = plans.intents.get(good.id);
  if (!saved && accountQuota && accountQuota.used >= accountQuota.limit) {
    const disabled = add("button", "reservation-submit", $t("web.miyoushe.app.text_0bcaee4721"));
    disabled.type = "button";
    disabled.disabled = true;
    panel.append(disabled);
    return panel;
  }
  const immediate = saved?.body.immediate ?? good.status === "available";
  if (!saved && !immediate && good.status !== "scheduled") {
    panel.append(add("p", "muted", $t("web.miyoushe.app.text_c46617b735")));
    return panel;
  }
  const targets = good.type === 2 ? roles : good.type === 1 && Array.isArray(addresses) ? addresses : [];
  const community = communityAccountGood(good);
  if (!saved && !community && targets.length === 0) return panel;

  const selector = add("select", "", "");
  selector.id = "reservation-target";
  selector.required = !community;
  selector.hidden = community;
  const targetField = add("label", "reservation-target", community ? $t("web.miyoushe.app.text_a16de22f28") : good.type === 2 ? $t("web.miyoushe.app.text_0af5cf87c2") : $t("web.miyoushe.app.text_445edb7272"));
  selector.append(new Option($t("web.miyoushe.app.text_ee78990244"), ""), ...targets.map((target, index) =>
    new Option(good.type === 2 ? "UID " + (target as Role).uid + " · " + roleLabel(target as Role) : (target as Address).label, String(index))));
  if (targets.length === 1) selector.value = "0";
  targetField.htmlFor = selector.id;
  targetField.append(selector);

  const confirm = add("input", "", "");
  confirm.type = "checkbox";
  confirm.required = true;
  confirm.id = "reservation-confirm";
  const confirmation = add("label", "reservation-confirm", "");
  confirmation.append(confirm, add("span", "", $t("web.miyoushe.app.text_b765e887c3") + point(saved?.body.expectedPrice ?? good.price) +
    $t("web.miyoushe.app.text_245d41429f") + (immediate ? $t("web.miyoushe.app.text_ad70cdf33a") : $t("web.miyoushe.app.text_0d619cbbef"))));
  const message = add("p", "muted", "");
  message.id = "reservation-message";
  message.setAttribute("role", "status");
  const submit = add("button", "reservation-submit", "");
  submit.type = "submit";
  submit.id = "reservation-submit";
  const scope = plans.scope;

  function update() {
    const draft = plans.intents.get(good.id);
    const submitting = draft?.submitting === true;
    selector.disabled = Boolean(draft);
    confirm.disabled = Boolean(draft);
    submit.disabled = submitting || (!draft && (!confirm.checked || (!community && !selector.value)));
    submit.textContent = submitting ? $t("web.miyoushe.app.text_26ef00b7d0") : draft ? $t("web.miyoushe.app.text_8d7d39d122") : immediate ? $t("web.miyoushe.app.text_cb5a0ff582") : $t("web.miyoushe.app.text_00a4c1e24d");
    if (draft) message.textContent = draft.note || "";
  }
  plans.activeForm = { id: good.id, update, reject(problem) {
    confirm.checked = false;
    message.textContent = problem;
    update();
  } };
  if (saved) {
    const match = targets.findIndex(target => good.type === 2
      ? (target as Role).uid === saved.body.uid && (target as Role).region === saved.body.region : (target as Address).id === saved.body.addressId);
    selector.value = match < 0 ? "" : String(match);
    confirm.checked = true;
  }
  for (const element of [selector, confirm]) element.addEventListener("change", update);
  update();
  panel.append(targetField, confirmation, message, submit);
  panel.addEventListener("submit", async event => {
    event.preventDefault();
    if (scope !== plans.scope || submit.disabled) return;
    let draft = plans.intents.get(good.id);
    if (!draft) {
      const target = targets[Number(selector.value)];
      if (!confirm.checked || (!community && (!selector.value || !target))) return;
      if (!immediate && good.opensAt! <= Date.now() + shop.nowOffset) {
        message.textContent = $t("web.miyoushe.app.text_99dc1cd57f");
        return;
      }
      const intentId = createIntentId();
      if (!intentId) {
        message.textContent = $t("web.miyoushe.app.text_840cc597dd");
        return;
      }
      const destination = community ? {} : good.type === 2 ? { uid: (target as Role).uid, region: (target as Role).region } : { addressId: (target as Address).id };
      draft = { body: { goodsId: good.id, expectedPrice: good.price, immediate, confirmed: true,
        ...destination, intentId } };
      plans.intents.set(good.id, draft);
    }
    const currentForm = () => plans.activeForm?.id === good.id ? plans.activeForm : null;
    draft.submitting = true;
    draft.note = $t("web.miyoushe.app.text_5c22ba2931");
    update();
    try {
      const response = await postPlan("api/plans", draft.body);
      if (scope !== plans.scope) return;
      if (response.status === 401 || response.status === 403) {
        showLogin(loginHelp, true);
        return;
      }
      if (!response.ok) {
        const problem = await planFailure(response);
        if (scope !== plans.scope) return;
        if (!draft.uncertain && [400, 404, 409].includes(response.status)) {
          plans.intents.delete(good.id);
          currentForm()?.reject(problem);
          return;
        }
        draft.uncertain = true;
        draft.note = problem + $t("web.miyoushe.app.text_67aca306ff");
        return;
      }
      const plan = await response.json() as Plan;
      if (scope !== plans.scope) return;
      plans.intents.delete(good.id);
      plans.revision++;
      if (plans.data) {
        plans.data = { ...plans.data, plans: [plan, ...plans.data.plans.filter(row => row.id !== plan.id)] };
      }
      if (currentForm() && get("shop-detail").open) {
        get("shop-detail").close();
        switchTab("plans");
      }
      renderPlans();
      if (plan.status === "succeeded") void refresh();
      planNote(plan.immediate ? $t("web.miyoushe.app.text_cda4c99b5c") : $t("web.miyoushe.app.text_201c78f63f"));
      if (tab === "plans") void loadPlans();
    } catch {
      draft.uncertain = true;
      draft.note = $t("web.miyoushe.app.text_4f459fa014");
    } finally {
      draft.submitting = false;
      if (scope === plans.scope) currentForm()?.update();
    }
  });
  return panel;
}

async function request(path: string, options?: RequestInit) {
  return fetch(path, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(20_000), ...options });
}

function updateBusy(value: boolean) {
  busy = value;
  for (const id of ["refresh", "logout", "login-retry"] as const) get(id).disabled = value;
  get("overview-view").setAttribute("aria-busy", String(value));
  if (!value && pendingTicket) {
    pendingTicket = false;
    queueMicrotask(() => void connect());
  }
}

async function refresh(allViews = false) {
  if (busy) return;
  updateBusy(true);
  showNotice($t("web.miyoushe.app.text_03b28caa06"));
  const scope = plans.scope;
  const otherReads = allViews ? Promise.all([loadCatalog(), loadTrackers(), loadPlans()]) : undefined;
  try {
    const response = await request("api/overview");
    if (scope !== plans.scope) return;
    if (response.status === 401 || response.status === 403) {
      showLogin(loginHelp, true);
      return;
    }
    if (response.status === 404) {
      showLogin($t("web.miyoushe.app.text_2e9f297a11"), true);
      return;
    }
    if (!response.ok) throw new Error($t("web.miyoushe.app.text_33bfcc54ff"));
    const data = await response.json() as Overview;
    if (scope !== plans.scope) return;
    showOverview(data);
    showNotice("");
    if (!get("dashboard").hidden) {
      get("manual-checkin").hidden = data.manualCheckinAvailable !== true;
      if (tab === "overview") void updateManualCheckin();
      for (const editor of profileEditors) {
        get(editor.key + "-settings").hidden = data[(editor.key + "SettingsAvailable") as `${SettingsKey}SettingsAvailable`] !== true;
        if (tab === "overview") void updateProfileSettings(editor);
      }
    }
    if (!allViews && !get("dashboard").hidden && tab === "shop") await loadCatalog();
  } catch {
    if (scope !== plans.scope) return;
    if (get("dashboard").hidden) showLogin($t("web.miyoushe.app.text_b1b42e9d91"), false, true);
    else showNotice($t("web.miyoushe.app.text_83d8486b06"), true);
  } finally {
    await otherReads;
    updateBusy(false);
  }
}

async function logout() {
  if (busy) return;
  updateBusy(true);
  try {
    const response = await request("api/logout", { method: "POST" });
    if (response.ok || response.status === 401) showLogin($t("web.miyoushe.app.text_6e827a1b34"), true);
    else showNotice($t("web.miyoushe.app.text_c184b46dd7"), true);
  } catch {
    showNotice($t("web.miyoushe.app.text_98cdf0e733"), true);
  } finally {
    updateBusy(false);
  }
}

get("refresh").addEventListener("click", () => void refresh(true));
get("login-retry").addEventListener("click", () => void refresh());
get("logout").addEventListener("click", logout);
get("tab-overview").addEventListener("click", () => {
  switchTab("overview");
  void updateManualCheckin();
  for (const editor of profileEditors) if (!editor.data) void updateProfileSettings(editor);
});
get("manual-checkin-start").addEventListener("click", () => {
  if (!get("manual-checkin-start").disabled) void updateManualCheckin(true);
});
for (const editor of profileEditors) {
  const form = get((editor.key + "-settings-form") as `${SettingsKey}-settings-form`);
  form.addEventListener("change", editor.buttons);
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!get((editor.key + "-settings-save") as `${SettingsKey}-settings-save`).disabled) void updateProfileSettings(editor, editor.patch());
  });
}
get("tab-shop").addEventListener("click", () => {
  switchTab("shop");
  if (!shop.data && !shop.catalogRequest) void loadCatalog();
});
get("tab-trackers").addEventListener("click", () => {
  switchTab("trackers");
  void loadTrackers();
});
get("tracker-open").addEventListener("click", () => openTracker());
get("tracker-close").addEventListener("click", () => get("tracker-dialog").close());
get("tracker-dialog").addEventListener("close", () => trackers.targets?.abort());
get("tracker-form").elements.mode.addEventListener("change", trackerMode);
get("tracker-form").addEventListener("input", ({ target }) => {
  const { confirmed } = get("tracker-form").elements;
  if (target !== confirmed) confirmed.checked = false;
});
get("tracker-form").elements.game.addEventListener("change", () => void loadTrackerTargets());
get("tracker-form").elements.itemType.addEventListener("change", () => {
  trackerGameOptions(get("tracker-form").elements.game.value);
  void loadTrackerTargets();
});
get("tracker-form").addEventListener("submit", event => void saveTracker(event));
get("tab-plans").addEventListener("click", () => {
  switchTab("plans");
  void loadPlans();
});
document.addEventListener("visibilitychange", () => {
  if (tab !== "plans" || get("dashboard").hidden) return;
  if (document.hidden) clearTimeout(plans.timer);
  else void loadPlans(true);
});
get("shop-game").addEventListener("change", event => void loadCatalog(1, (event.target as HTMLSelectElement).value));
get("shop-status").addEventListener("change", renderGoods);
get("shop-search").addEventListener("input", renderGoods);
get("shop-previous").addEventListener("click", () => { if (shop.page > 1) void loadCatalog(shop.page - 1); });
get("shop-next").addEventListener("click", () => { if (shop.page < shop.data?.totalPages!) void loadCatalog(shop.page + 1); });
get("shop-close").addEventListener("click", () => get("shop-detail").close());
get("shop-detail").addEventListener("close", () => {
  if (get("shop-detail").open) return;
  shop.detailRequest?.abort();
  plans.activeForm = null;
});
setInterval(() => {
  if (!get("dashboard").hidden) get("clock").textContent = clock.format();
  if (tab === "shop") tickShop();
}, 1000);
setInterval(() => {
  if (tab === "trackers" && !document.hidden && !get("dashboard").hidden && !get("tracker-dialog").open) void loadTrackers();
}, 3_000);
addEventListener("pageshow", event => {
  if ((event as PageTransitionEvent).persisted) {
    showLogin($t("web.miyoushe.app.text_282b3bd3fe"));
    void refresh();
  }
});
async function connect() {
  const ticket = /^#ticket=([A-Za-z0-9_-]{43})(&tab=shop)?$/u.exec(location.hash);
  if (!ticket) return refresh();
  if (busy) {
    pendingTicket = true;
    return;
  }
  history.replaceState(history.state, "", location.pathname);
  showLogin($t("web.miyoushe.app.text_282b3bd3fe"));
  if (ticket[2]) switchTab("shop");
  updateBusy(true);
  try {
    const response = await request("api/claim", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket: ticket[1] }),
    });
    if (!response.ok) {
      showLogin($t("web.miyoushe.app.text_c4cbeba016"), true);
      return;
    }
  } catch {
    showLogin($t("web.miyoushe.app.text_42e0f6baea"), true, true);
    return;
  } finally {
    updateBusy(false);
  }
  return refresh();
}

addEventListener("hashchange", () => { if (location.hash.startsWith("#ticket=")) void connect(); });
void connect();
