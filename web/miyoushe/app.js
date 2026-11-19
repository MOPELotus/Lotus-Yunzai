const get = id => document.getElementById(id);
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
const games = { gs: "原神", sr: "崩坏：星穹铁道", zzz: "绝区零" };
const loginHelp = "请私聊机器人发送下方指令，获取当前档案的专属登录链接。";
let busy = false;
let pendingTicket = false;
let expiryTimer;
let tab = "overview";
const shopStatuses = { available: "正在兑换", scheduled: "等待开放", sold_out: "已兑完", ended: "已结束", unknown: "状态待确认" };
const shop = { data: null, game: "", page: 1, nowOffset: 0, catalogRequest: null, detailRequest: null };
const plans = { data: null, loading: null, scope: 0, revision: 0, activeForm: null, actions: new Set(), intents: new Map() };
const preview = { key: "preview", data: null, active: null, patch: previewPatch, buttons: previewSettingsButtons, render: renderPreviewSettings };
const checkin = { key: "checkin", data: null, active: null, patch: checkinPatch, buttons: checkinSettingsButtons, render: renderCheckinSettings };
const profileEditors = [checkin, preview];
const trackers = { generation: 0, targets: null, loading: false };
const trackGames = { hk4e: "原神", hkrpg: "崩坏：星穹铁道", nap: "绝区零", bh3: "崩坏3", bh2: "崩坏学园2", nxx: "未定事件簿", bbs: "米游社" };
const planStatus = {
  scheduled: "等待开放", preparing: "准备兑换", submitting: "正在提交", succeeded: "兑换成功",
  failed: "未成功", cancelled: "已取消", missed: "已错过", unknown: "结果待确认",
};

function add(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

function point(value) {
  return Number.isSafeInteger(value) && value >= 0 ? number.format(value) : "—";
}

function showLogin(message, help = false, retry = false) {
  clearTimeout(expiryTimer);
  get("dashboard").hidden = true;
  get("login").hidden = false;
  get("login-message").textContent = message;
  get("login-command").hidden = !help;
  get("login-retry").hidden = !retry;
  get("profile-name").textContent = "";
  get("profile").textContent = "";
  get("session-expiry").textContent = "";
  get("account-state").textContent = "";
  get("today-schedule").textContent = "";
  get("missions-empty").textContent = "";
  for (const id of ["balance", "received", "today-total"]) get(id).textContent = "—";
  for (const id of ["roles", "missions"]) get(id).replaceChildren();
  for (const editor of profileEditors) {
    editor.active?.abort();
    editor.active = null;
    editor.data = null;
    get(editor.key + "-settings").hidden = true;
    get(editor.key + "-settings-form").reset();
    editor.buttons();
  }
  resetShop();
  switchTab("overview");
}

function previewPatch() {
  return {
    enabled: get("preview-enabled").checked,
    games: Array.from(get("preview-games").querySelectorAll("input:checked"), input => input.value),
    revision: preview.data?.revision,
  };
}

function previewSettingsButtons() {
  const loaded = preview.data;
  get("preview-games").disabled = !loaded || Boolean(preview.active);
  get("preview-enabled").disabled = !loaded || Boolean(preview.active) || (loaded.canEnable === false && !loaded.enabled);
  const patch = previewPatch();
  get("preview-settings-save").disabled = !loaded || Boolean(preview.active) || (patch.enabled && !patch.games.length) ||
    (patch.enabled === loaded.enabled && patch.games.length === loaded.games.length && patch.games.every(game => loaded.games.includes(game)));
  get("preview-settings-form").setAttribute("aria-busy", String(Boolean(preview.active)));
}

function renderPreviewSettings(data) {
  get("preview-enabled").checked = data.enabled;
  for (const input of get("preview-games").querySelectorAll("input")) input.checked = data.games.includes(input.value);
  const messages = [];
  if (data.waitingForHistory) messages.push("旧档案需要补齐兑换记录后才会自动兑换。");
  if (data.canEnable === false && !data.enabled) messages.push("当前档案没有开启自动兑换的权限。");
  return messages.join(" ");
}

const checkinSwitches = ["enabled", "notify", "community"];
const checkinCloudGames = { genshin: "云原神", zzz: "云绝区零" };

function checkedFlags(fieldset, selector = "input") {
  return Object.fromEntries(Array.from(get(fieldset).querySelectorAll(selector), input => [input.value, input.checked]));
}

function sameFlags(patch, saved) {
  return Object.entries(patch).every(([key, value]) => saved[key] === value);
}

function checkinPatch() {
  return {
    revision: checkin.data?.revision,
    enabled: get("checkin-enabled").checked,
    notify: get("checkin-notify").checked,
    community: get("checkin-community").checked,
    games: checkedFlags("checkin-games"),
    forums: Array.from(get("checkin-forums").querySelectorAll("input:checked"), input => Number(input.value)),
    cloud: checkedFlags("checkin-cloud"),
    osEnabled: get("checkin-os-enabled").checked,
    os: checkedFlags("checkin-os", 'input[name="os"]'),
  };
}

function checkinSettingsButtons() {
  const loaded = checkin.data;
  const pending = Boolean(checkin.active);
  for (const field of ["checkin-games", "checkin-switches", "checkin-forums", "checkin-cloud", "checkin-os"]) {
    get(field).disabled = !loaded || pending;
  }
  get("checkin-enabled").disabled = !loaded || (loaded.canEnable === false && !loaded.enabled);
  for (const game of Object.keys(checkinCloudGames)) {
    get("checkin-cloud-" + game).disabled = !loaded || (!loaded.cloudBound[game] && !loaded.cloud[game]);
  }
  const patch = checkinPatch();
  get("checkin-settings-save").disabled = !loaded || pending ||
    (checkinSwitches.every(key => patch[key] === loaded[key]) && sameFlags(patch.games, loaded.games) &&
      sameFlags(patch.cloud, loaded.cloud) && patch.forums.length === loaded.forums.length && patch.forums.every(id => loaded.forums.includes(id)) &&
      patch.osEnabled === loaded.osEnabled && sameFlags(patch.os, loaded.os));
  get("checkin-settings-form").setAttribute("aria-busy", String(pending));
}

function renderCheckinSettings(data) {
  for (const key of checkinSwitches) get("checkin-" + key).checked = data[key];
  for (const input of get("checkin-games").querySelectorAll("input")) input.checked = data.games[input.value] === true;
  for (const input of get("checkin-forums").querySelectorAll("input")) input.checked = data.forums.includes(Number(input.value));
  for (const game of Object.keys(checkinCloudGames)) get("checkin-cloud-" + game).checked = data.cloud[game];
  get("checkin-os-enabled").checked = data.osEnabled;
  for (const input of get("checkin-os").querySelectorAll('input[name="os"]')) input.checked = data.os[input.value];
  const messages = [];
  if (data.cnEnabled === false) messages.push("当前档案的国服签到总开关已关闭，各游戏的选择仍会保留。");
  if (data.canEnable === false && !data.enabled) messages.push("当前档案没有开启自动签到的权限。");
  const unbound = Object.entries(checkinCloudGames).filter(([game]) => !data.cloudBound[game]).map(([, label]) => label);
  if (unbound.length) messages.push(`${unbound.join("、")}需先在聊天中绑定账户，才能执行钱包签到。`);
  if (!data.osBound) messages.push("国际服签到需先在聊天中绑定 HoYoLAB 账号。");
  return messages.join(" ");
}

async function updateProfileSettings(editor, patch) {
  if (editor.active || get(editor.key + "-settings").hidden) return;
  const active = editor.active = new AbortController();
  const deadline = AbortSignal.any([active.signal, AbortSignal.timeout(20_000)]);
  const notice = get(editor.key + "-settings-note");
  editor.buttons();
  notice.classList.remove("error");
  notice.textContent = patch ? "正在保存设置…" : "正在读取设置…";
  try {
    const response = await request("api/" + editor.key + "-settings", patch ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch), signal: deadline,
    } : { signal: deadline });
    if (active.signal.aborted) return;
    if (response.status === 401) {
      showLogin(`登录已失效。${loginHelp}`, true);
      return;
    }
    if (!response.ok) throw new Error(await planFailure(response));
    const data = await response.json();
    if (active.signal.aborted) return;
    const previous = editor.data;
    editor.data = data;
    const message = editor.render(data);
    if (patch) {
      // Both sections use the same profile revision. Keep the other section's
      // unchanged settings and any unsaved edits after our own successful write.
      for (const other of profileEditors) if (other !== editor && other.data?.revision === patch.revision) {
        other.data = { ...other.data, revision: data.revision };
      }
      if (editor === checkin && previous?.enabled !== data.enabled) {
        const schedule = get("today-schedule");
        schedule.textContent = data.enabled ? "档案自动签到已开启。刷新后查看今日安排。" : "自动签到已关闭。";
        schedule.hidden = false;
      }
    }
    notice.textContent = patch ? ["设置已保存。", message].filter(Boolean).join(" ") : message;
  } catch (error) {
    if (active.signal.aborted) return;
    notice.classList.add("error");
    notice.textContent = error instanceof TypeError || deadline.aborted
      ? (patch ? "保存结果尚未确认，请刷新设置。" : "设置读取失败，请刷新后重试。")
      : error.message;
  } finally {
    if (editor.active === active) {
      editor.active = null;
      editor.buttons();
    }
  }
}

function showNotice(message, error = false) {
  const notice = get("notice");
  notice.textContent = message;
  notice.hidden = !message;
  notice.classList.toggle("error", error);
}

function scheduleText(schedule) {
  if (!schedule) return "";
  if (!schedule.enabled) return "自动签到已关闭。";
  if (!schedule.time) return "今日签到时间尚未安排。";
  const status = schedule.running ? "正在执行" :
    schedule.done ? (schedule.ok ? "已完成" : "执行未成功") : "等待执行";
  return `今日签到安排为 ${schedule.time} · ${status}`;
}

function missionRow(item) {
  const row = add("li", "mission-row", "");
  const status = item.isGetAward === true ? "已领奖" :
    item.isGetAward === false ? (
      Number.isSafeInteger(item.happenedTimes) && Number.isSafeInteger(item.threshold) &&
        item.happenedTimes < item.threshold ? "待完成" : "未领奖"
    ) : "状态未知";
  const progress = Number.isSafeInteger(item.happenedTimes) ?
    (Number.isSafeInteger(item.threshold) ? `${item.happenedTimes} / ${item.threshold}` : `已完成 ${item.happenedTimes} 次`) : "";
  row.append(add("span", "", item.label), add("span", item.isGetAward === true ? "complete" : "muted",
    [progress, status].filter(Boolean).join(" · ")));
  return row;
}

function showOverview(data) {
  const { account, displayName, missions, missionError, todaySchedule, profileId, expiresAt } = data;
  const profile = `档案 ${profileId}`;
  get("profile").textContent = profile;
  get("profile-name").textContent = displayName || profile;
  get("session-expiry").textContent = Number.isSafeInteger(expiresAt) ? `登录有效至 ${expiry.format(expiresAt)}（北京时间）` : "";
  clearTimeout(expiryTimer);
  if (Number.isSafeInteger(expiresAt)) {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      showLogin(`登录已失效。${loginHelp}`, true);
      return;
    }
    if (remaining <= 2_147_483_647) {
      expiryTimer = setTimeout(() => showLogin(`登录已失效。${loginHelp}`, true), remaining);
    }
  }
  get("account-state").textContent = `${account.loggedIn ? "已登录" : "未登录"} · ${account.deviceBound ? "设备已绑定" : "待绑定设备"}`;
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
  get("missions-empty").hidden = Boolean(missions?.items.length);
  get("missions-empty").textContent = missionError || (missions ? "当前没有可展示的社区任务。" : "暂时无法读取社区任务和余额。");
  get("missions").replaceChildren(...(missions?.items.map(missionRow) ?? []));
  get("login").hidden = true;
  get("dashboard").hidden = false;
  get("clock").textContent = clock.format();
}

function switchTab(next) {
  tab = next;
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
  get("shop-game").replaceChildren(new Option("全部商品", ""));
  get("shop-status").value = "all";
  get("shop-search").value = "";
  get("shop-pagination").hidden = true;
  get("shop-detail").close();
  get("shop-detail-content").replaceChildren();
  plans.scope++;
  plans.data = null;
  plans.loading = null;
  plans.activeForm = null;
  plans.actions.clear();
  plans.intents.clear();
  get("plans-note").textContent = "";
  get("shop-plans").replaceChildren();
  trackers.generation++;
  trackers.targets?.abort();
  trackers.loading = false;
  get("tracker-dialog").close();
  get("tracker-open").disabled = true;
  get("trackers-note").textContent = "";
  get("shop-trackers").replaceChildren();
}

function shopTime(milliseconds) {
  return Number.isSafeInteger(milliseconds) ? shopClock.format(milliseconds) + "（北京时间）" : "未知";
}

function tickShop() {
  const now = Date.now() + shop.nowOffset;
  for (const line of document.querySelectorAll("[data-shop-deadline]")) {
    const seconds = Math.ceil((Number(line.dataset.shopDeadline) - now) / 1000);
    if (seconds <= 0) {
      line.textContent = "已到开放时间，请刷新官方库存";
      continue;
    }
    const days = Math.floor(seconds / 86400);
    const time = [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
      .map(value => String(value).padStart(2, "0")).join(":");
    line.textContent = "距开放 " + (days ? days + " 天 " : "") + time;
  }
}

function shopIcon(good) {
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

function shopFacts(good, detail = false) {
  const facts = add("dl", "shop-facts", "");
  function item(label, value) { facts.append(add("dt", "", label), add("dd", "", value)); }
  item("当前库存", good.unlimited ? "不限量" : good.stock == null ? "未知" : point(good.stock));
  if (good.opensAt) {
    item("开放时间", shopTime(good.opensAt));
    item("下一批数量", good.nextStock == null ? "未知" : point(good.nextStock));
  }
  if (detail && good.endsAt) item("结束时间", shopTime(good.endsAt));
  if (good.accountLimit > 0) item("账号限购", point(good.accountLimit));
  if (detail && good.roleLimit > 0) item("角色限购", point(good.roleLimit));
  return facts;
}

function statusBadge(status) {
  const known = Object.hasOwn(shopStatuses, status) ? status : "unknown";
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
    const action = add("button", "secondary good-action", "查看商品详情");
    action.type = "button";
    action.addEventListener("click", () => void openDetail(good.id));
    content.append(add("h3", "", good.name), add("p", "shop-price", point(good.price) + " 米游币"), shopFacts(good));
    if (good.opensAt) {
      const countdown = add("p", "countdown", "");
      countdown.dataset.shopDeadline = String(good.opensAt);
      content.append(countdown);
    }
    content.append(action);
    card.append(visual, content);
    return card;
  });
  get("shop-goods").replaceChildren(...(cards.length ? cards : [add("p", "shop-empty", "当前页没有符合条件的商品。")]));
  tickShop();
}

function catalogControls(data) {
  const game = get("shop-game");
  game.replaceChildren(new Option("全部商品", ""), ...data.games.map(item => new Option(item.name, item.key)));
  if (![...game.options].some(option => option.value === shop.game)) game.append(new Option(shop.game, shop.game));
  game.value = shop.game;
  get("shop-page").textContent = data.page + " / " + data.totalPages;
  get("shop-previous").disabled = data.page <= 1;
  get("shop-next").disabled = data.page >= data.totalPages;
  get("shop-pagination").hidden = false;
}

function shopProblem(response, detail = false) {
  if (response.status === 429) return "商城请求频繁，请稍后再试。";
  if (detail && response.status === 404) return "商品不存在或已下架。";
  return detail ? "暂时无法读取商品详情。" : "暂时无法读取商城商品。";
}

async function shopRequest(path, controller) {
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
  return request(path, { signal });
}

async function loadCatalog(page = shop.page, game = shop.game) {
  shop.catalogRequest?.abort();
  const controller = new AbortController();
  shop.catalogRequest = controller;
  get("shop-note").textContent = "正在读取官方商品…";
  try {
    const query = new URLSearchParams({ page: String(page), game });
    const response = await shopRequest("api/catalog?" + query, controller);
    if (controller.signal.aborted) return;
    if (response.status === 401 || response.status === 403) {
      showLogin(loginHelp, true);
      return;
    }
    if (!response.ok) throw new Error(shopProblem(response));
    const data = await response.json();
    if (controller.signal.aborted) return;
    shop.data = data;
    shop.page = data.page;
    shop.game = game;
    shop.nowOffset = data.now - Date.now();
    catalogControls(data);
    renderGoods();
    get("shop-note").textContent = point(data.total) + " 件商品 · 第 " + data.page + " 页";
  } catch (error) {
    if (controller.signal.aborted) return;
    const message = error instanceof Error && error.name === "Error" ? error.message : "暂时无法读取商城商品。";
    get("shop-note").textContent = message + (shop.data ? "当前显示上次读取的商品。" : "");
    get("shop-game").value = shop.game;
  } finally {
    if (shop.catalogRequest === controller) shop.catalogRequest = null;
  }
}

function detailContent({ good, roles, roleError, addresses }) {
  const blocks = [add("h3", "", good.name), statusBadge(good.status),
    add("p", "shop-price", point(good.price) + " 米游币"), shopFacts(good, true),
    add("h4", "", "兑换条件"), add("p", "detail-copy", good.requirements || "官方暂未提供额外兑换说明。")];
  if (good.type === 1) blocks.push(add("p", "muted", "实物商品需要米游社收货地址。"));
  if (good.type === 2) {
    if (roleError || !roles.length) {
      blocks.push(add("h4", "", "当前档案绑定的角色"), add("p", "muted", roleError || "没有找到此商品对应的绑定角色。"));
    } else if (!plans.data?.canSubmit || (!plans.intents.has(good.id) && !["available", "scheduled"].includes(good.status))) {
      blocks.push(add("h4", "", "当前档案绑定的角色"));
      const list = add("ul", "rows", "");
      for (const role of roles) {
        const row = add("li", "role-row", "");
        row.append(add("span", "", roleLabel(role)), add("span", "muted", "UID " + role.uid));
        list.append(row);
      }
      blocks.push(list, add("p", "muted", "实际兑换条件请以米游社商品说明为准。"));
    }
  }
  blocks.push(reservationForm(good, roles, addresses));
  return blocks;
}

async function openDetail(id) {
  shop.detailRequest?.abort();
  const controller = new AbortController();
  shop.detailRequest = controller;
  const dialog = get("shop-detail"), content = get("shop-detail-content");
  plans.activeForm = null;
  content.replaceChildren(add("p", "muted", "正在读取商品详情…"));
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
    const data = await response.json();
    if (!controller.signal.aborted) content.replaceChildren(...detailContent(data));
  } catch {
    if (!controller.signal.aborted) content.replaceChildren(add("p", "error", "暂时无法读取商品详情。"));
  } finally {
    if (shop.detailRequest === controller) shop.detailRequest = null;
  }
}

function roleLabel(role) {
  return [role.nickname || "角色", role.regionName || role.region, role.level ? "Lv." + role.level : ""]
    .filter(Boolean).join(" · ");
}

function planNote(message, error = false) {
  const notice = get("plans-note");
  notice.textContent = message;
  notice.classList.toggle("error", error);
}

function planRow(plan) {
  const row = add("article", "plan-row", "");
  const copy = add("div", "plan-copy", "");
  const status = Object.hasOwn(planStatus, plan.status) ? plan.status : "unknown";
  copy.append(add("span", "shop-badge " + status, planStatus[status]), add("h3", "", plan.goodsName),
    add("p", "muted", "档案 " + plan.profileId + " · " + point(plan.price) + " 米游币 × 1 · " + shopTime(plan.opensAt)));
  if (plan.role) copy.append(add("p", "muted", "游戏角色 UID " + plan.role.uid + " · " + plan.role.region));
  if (plan.addressLabel) copy.append(add("p", "muted", "收货地址 " + plan.addressLabel));
  if (plan.message) copy.append(add("p", "", plan.message));
  row.append(copy);
  if (!/^[a-f0-9]{12}$/u.test(plan.id)) return row;
  const actions = add("div", "plan-actions", "");
  function action(label, operation, body, prompt) {
    const button = add("button", "secondary", label);
    button.type = "button";
    button.disabled = plans.actions.has(plan.id);
    button.addEventListener("click", () => {
      if (!plans.actions.has(plan.id) && window.confirm(prompt)) void changePlan(plan.id, operation, body);
    });
    actions.append(button);
  }
  if (plan.status === "scheduled" || plan.status === "preparing") {
    action("取消预约", "cancel", {}, "取消「" + plan.goodsName + "」的预约？");
  } else if (plan.status === "unknown") {
    for (const [label, redeemed] of [["已在官方记录确认成功", true], ["已确认未兑换", false]]) {
      action(label, "resolve", { redeemed }, "请先在米游社核对「" + plan.goodsName + "」的兑换记录。" +
        (redeemed ? "确定标记为已兑换？" : "确定标记为未兑换？"));
    }
  }
  if (actions.children.length) row.append(actions);
  return row;
}

function renderPlans() {
  if (!plans.data) return;
  const rows = plans.data.plans.map(planRow);
  get("shop-plans").replaceChildren(...(rows.length ? rows : [add("p", "shop-empty", "暂无兑换记录。")]));
}

function loadPlans() {
  if (plans.loading) return plans.loading;
  const scope = plans.scope;
  const revision = plans.revision;
  planNote("正在读取兑换记录…");
  plans.loading = (async () => {
    try {
      const response = await request("api/plans");
      if (scope !== plans.scope) return;
      if (response.status === 401 || response.status === 403) {
        showLogin(loginHelp, true);
        return;
      }
      if (!response.ok) throw new Error("读取失败");
      const data = await response.json();
      if (scope !== plans.scope || revision !== plans.revision) return;
      plans.data = data;
      renderPlans();
      const messages = [];
      if (!data.canSubmit) messages.push("预约兑换服务暂未启用。");
      if (plans.intents.size) messages.push("另有提交待确认，可返回商品详情重试原请求。");
      planNote(messages.join(" "));
    } catch {
      if (scope !== plans.scope || revision !== plans.revision) return;
      if (plans.data) plans.data = { ...plans.data, canSubmit: false };
      planNote(plans.data ? "刷新失败，当前显示上次读取的兑换记录。" : "暂时无法读取兑换记录。", true);
    } finally {
      if (scope === plans.scope) plans.loading = null;
    }
  })();
  return plans.loading;
}

async function postPlan(path, body) {
  return request(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

async function planFailure(response) {
  const data = await response.json().catch(() => null);
  if (typeof data?.message === "string" && data.message.length <= 200) return data.message;
  if (response.status === 409) return "当前兑换状态已变化，请刷新记录。";
  if (response.status === 404) return "兑换记录不存在，请刷新记录。";
  return "暂时无法完成操作，请稍后重试。";
}

async function trackingResponse(response) {
  if (response.status === 401) {
    showLogin(`登录已失效。${loginHelp}`, true);
    throw new Error("登录已失效。");
  }
  if (!response.ok) throw new Error(await planFailure(response));
  return response.json();
}

async function loadTrackers() {
  if (trackers.loading) return;
  const generation = trackers.generation;
  const note = get("trackers-note");
  trackers.loading = true;
  try {
    const data = await trackingResponse(await request("api/trackers"));
    if (trackers.generation !== generation) return;
    get("tracker-open").disabled = !data.canTrack;
    note.textContent = data.canTrack ? "" : "暂时无法启动追踪规则。";
    const rows = data.trackers.map(rule => {
      const row = add("article", "plan-row", "");
      const copy = add("div", "plan-copy", "");
      const actions = add("div", "plan-actions", "");
      const group = (Object.hasOwn(trackGames, rule.game) && trackGames[rule.game]) || rule.game || "未知分区";
      const item = rule.itemType === 1 ? "实物周边" : rule.itemType === 2 ? "游戏道具" : "类型待核对";
      if (rule.migrationBlocked) {
        copy.append(add("h3", "", `${group} · ${item}`), add("p", "muted", rule.message),
          add("p", "muted", `已用 ${point(rule.spent)} · 待结算 ${point(rule.held)}`));
        row.append(copy);
        return row;
      }
      const selection = rule.mode === "goods" ? (rule.names.length ? rule.names : rule.goodsIds).join("、")
        : rule.keywords.join("、") || "全部商品";
      const limit = rule.spendLimit === null ? "不限" : point(rule.spendLimit);
      const destination = rule.role ? `UID ${rule.role.uid} · ${rule.role.region}` : rule.addressLabel;
      copy.append(add("h3", "", `${group} · ${item}`), add("p", "", selection),
        add("p", "muted", `${destination} · 已用 ${point(rule.spent)} / ${limit} · 待结算 ${point(rule.held)}`),
        add("p", "muted", `${rule.enabled ? "追踪中" : "已暂停"} · ${rule.message}`));
      if (rule.enabled && Number.isSafeInteger(rule.nextOpenAt)) copy.append(add("p", "muted", `下次开放 ${shopTime(rule.nextOpenAt)}`));
      if (rule.enabled || data.canTrack) {
        const toggle = add("button", "secondary", rule.enabled ? "暂停" : rule.needsConfirmation ? "确认并恢复" : "恢复");
        toggle.type = "button";
        toggle.addEventListener("click", async () => {
          const action = rule.enabled ? "pause" : "resume";
          if (!rule.enabled && !window.confirm(`确认使用当前档案的米游币继续兑换 ${group} · ${selection}？累计预算 ${limit}。`)) return;
          toggle.disabled = true;
          try {
            await trackingResponse(await postPlan(`api/trackers/${rule.id}/${action}`, { confirmed: !rule.enabled }));
            if (trackers.generation === generation) await loadTrackers();
          } catch (error) {
            if (trackers.generation === generation) note.textContent = error.message;
          } finally { toggle.disabled = false; }
        });
        actions.append(toggle);
      }
      row.append(copy, actions);
      return row;
    });
    get("shop-trackers").replaceChildren(...(rows.length ? rows : [add("p", "shop-empty", "暂无追踪规则。")]));
  } catch (error) {
    if (trackers.generation === generation) note.textContent = error.message;
  } finally {
    if (trackers.generation === generation) trackers.loading = false;
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
  note.textContent = "正在核验当前档案的兑换目标…";
  try {
    const data = await trackingResponse(await request("api/tracking-targets?" + query, { signal: controller.signal }));
    if (controller.signal.aborted) return;
    const options = data.items.map(item => data.type === "role" ? new Option(`UID ${item.uid} · ${item.region}`, item.uid)
      : new Option(item.label || "已脱敏地址", item.id));
    form.destination.replaceChildren(...options);
    submit.disabled = !options.length;
    note.textContent = options.length ? "" : "当前档案没有可用的兑换目标。";
  } catch (error) {
    if (!controller.signal.aborted) note.textContent = error.message;
  }
}

function openTracker() {
  const form = get("tracker-form");
  form.reset();
  trackerGameOptions(shop.game);
  trackerMode();
  get("tracker-dialog").showModal();
  void loadTrackerTargets();
}

function trackerGameOptions(preferred) {
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
  form.game.replaceChildren(...entries.map(([key, name]) => new Option(name, key)));
  if (entries.some(([key]) => key === preferred)) form.game.value = preferred;
}

async function saveTracker(event) {
  event.preventDefault();
  const submit = get("tracker-submit");
  if (submit.disabled) return;
  const form = event.target.elements;
  const generation = trackers.generation;
  const split = field => field.value.split(/[,，]/u).map(item => item.trim()).filter(Boolean);
  const amount = field => field.value === "" ? null : Number(field.value);
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
    await loadTrackers();
  } catch (error) {
    if (generation === trackers.generation) get("tracker-form-note").textContent = error.message;
  } finally {
    if (generation === trackers.generation && get("tracker-dialog").open) submit.disabled = false;
  }
}

async function changePlan(id, action, body) {
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
    const plan = await response.json();
    if (scope !== plans.scope) return;
    plans.revision++;
    if (plans.data) {
      plans.data = { ...plans.data, plans: plans.data.plans.map(row => row.id === plan.id ? plan : row) };
      renderPlans();
    }
    planNote(action === "cancel" ? "已取消预约。" : "已记录核对结果。");
  } catch {
    if (scope === plans.scope) planNote("操作结果尚未确认，请刷新兑换记录。", true);
  } finally {
    if (scope === plans.scope) {
      plans.actions.delete(id);
      renderPlans();
    }
  }
}

function reservationForm(good, roles, addresses) {
  const panel = add("form", "reservation-form", "");
  if (!plans.data?.canSubmit) {
    panel.append(add("p", "muted", plans.data ? "预约兑换服务暂未启用。" : "暂时无法确认预约服务状态。"));
    return panel;
  }
  const saved = plans.intents.get(good.id);
  const immediate = saved?.body.immediate ?? good.status === "available";
  if (!saved && !immediate && good.status !== "scheduled") {
    panel.append(add("p", "muted", "当前商品不可兑换。"));
    return panel;
  }
  const targets = good.type === 2 ? roles : good.type === 1 && Array.isArray(addresses) ? addresses : [];
  if (!saved && targets.length === 0) return panel;

  const selector = add("select", "", "");
  selector.id = "reservation-target";
  selector.required = true;
  const targetField = add("label", "reservation-target", good.type === 2 ? "接收奖励的游戏角色" : "收货地址");
  selector.append(new Option("请选择兑换目标", ""), ...targets.map((target, index) =>
    new Option(good.type === 2 ? "UID " + target.uid + " · " + roleLabel(target) : target.label, String(index))));
  if (targets.length === 1) selector.value = "0";
  targetField.htmlFor = selector.id;
  targetField.append(selector);

  const confirm = add("input", "", "");
  confirm.type = "checkbox";
  confirm.required = true;
  confirm.id = "reservation-confirm";
  const confirmation = add("label", "reservation-confirm", "");
  confirmation.append(confirm, add("span", "", "使用当前档案的 " + point(saved?.body.expectedPrice ?? good.price) +
    " 米游币兑换 1 件。" + (immediate ? "确认后立即尝试兑换。" : "官方开放后自动尝试兑换。")));
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
    submit.disabled = submitting || (!draft && (!confirm.checked || !selector.value));
    submit.textContent = submitting ? "正在提交…" : draft ? "重试原请求" : immediate ? "确认立即兑换" : "创建兑换预约";
    if (draft) message.textContent = draft.note || "";
  }
  plans.activeForm = { id: good.id, update, reject(problem) {
    confirm.checked = false;
    message.textContent = problem;
    update();
  } };
  if (saved) {
    const match = targets.findIndex(target => good.type === 2
      ? target.uid === saved.body.uid && target.region === saved.body.region : target.id === saved.body.addressId);
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
      if (!confirm.checked || !selector.value || !target) return;
      if (!immediate && good.opensAt <= Date.now() + shop.nowOffset) {
        message.textContent = "商品开放时间已到，请刷新商城后重新确认。";
        return;
      }
      if (typeof crypto.randomUUID !== "function") {
        message.textContent = "当前浏览器无法生成兑换确认，请通过 HTTPS 页面重试。";
        return;
      }
      const destination = good.type === 2 ? { uid: target.uid, region: target.region } : { addressId: target.id };
      draft = { body: { goodsId: good.id, expectedPrice: good.price, immediate, confirmed: true,
        ...destination, intentId: crypto.randomUUID() } };
      plans.intents.set(good.id, draft);
    }
    const currentForm = () => plans.activeForm?.id === good.id ? plans.activeForm : null;
    draft.submitting = true;
    draft.note = "正在确认兑换计划…";
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
        draft.note = problem + "若需重试，请重试原请求。";
        return;
      }
      const plan = await response.json();
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
      planNote(plan.immediate ? "已创建兑换计划，处理结果见下方记录。" : "预约已创建，结果见下方记录。");
    } catch {
      draft.uncertain = true;
      draft.note = "提交结果待确认。可以重试原请求或查看兑换记录。";
    } finally {
      draft.submitting = false;
      if (scope === plans.scope) currentForm()?.update();
    }
  });
  return panel;
}

async function request(path, options) {
  return fetch(path, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(20_000), ...options });
}

function updateBusy(value) {
  busy = value;
  for (const id of ["refresh", "logout", "login-retry"]) get(id).disabled = value;
  get("overview-view").setAttribute("aria-busy", String(value));
  if (!value && pendingTicket) {
    pendingTicket = false;
    queueMicrotask(() => void connect());
  }
}

async function refresh() {
  if (busy) return;
  updateBusy(true);
  showNotice("正在刷新数据…");
  try {
    const response = await request("api/overview");
    if (response.status === 401 || response.status === 403) {
      showLogin(loginHelp, true);
      return;
    }
    if (response.status === 404) {
      showLogin("当前档案已不可用，请在聊天中检查档案。", true);
      return;
    }
    if (!response.ok) throw new Error("无法读取档案和任务。");
    const data = await response.json();
    showOverview(data);
    showNotice("");
    if (!get("dashboard").hidden) {
      for (const editor of profileEditors) {
        get(editor.key + "-settings").hidden = data[editor.key + "SettingsAvailable"] !== true;
        if (tab === "overview") void updateProfileSettings(editor);
      }
    }
    if (!get("dashboard").hidden && tab === "shop") await loadCatalog();
  } catch {
    if (get("dashboard").hidden) showLogin("暂时无法读取档案和任务。", false, true);
    else showNotice("刷新失败，当前显示上次读取的结果。", true);
  } finally {
    updateBusy(false);
  }
}

async function logout() {
  if (busy) return;
  updateBusy(true);
  try {
    const response = await request("api/logout", { method: "POST" });
    if (response.ok || response.status === 401) showLogin("已退出。", true);
    else showNotice("暂时无法退出，请重试。", true);
  } catch {
    showNotice("退出结果尚未确认，请重试。", true);
  } finally {
    updateBusy(false);
  }
}

get("refresh").addEventListener("click", () => {
  if (tab === "shop") void loadCatalog();
  else if (tab === "trackers") void loadTrackers();
  else if (tab === "plans") void loadPlans();
  else void refresh();
});
get("login-retry").addEventListener("click", refresh);
get("logout").addEventListener("click", logout);
get("tab-overview").addEventListener("click", () => {
  switchTab("overview");
  for (const editor of profileEditors) if (!editor.data) void updateProfileSettings(editor);
});
for (const editor of profileEditors) {
  const form = get(editor.key + "-settings-form");
  form.addEventListener("change", editor.buttons);
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!get(editor.key + "-settings-save").disabled) void updateProfileSettings(editor, editor.patch());
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
get("tracker-open").addEventListener("click", openTracker);
get("tracker-close").addEventListener("click", () => get("tracker-dialog").close());
get("tracker-dialog").addEventListener("close", () => trackers.targets?.abort());
get("tracker-form").elements.mode.addEventListener("change", trackerMode);
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
get("shop-game").addEventListener("change", event => void loadCatalog(1, event.target.value));
get("shop-status").addEventListener("change", renderGoods);
get("shop-search").addEventListener("input", renderGoods);
get("shop-previous").addEventListener("click", () => { if (shop.page > 1) void loadCatalog(shop.page - 1); });
get("shop-next").addEventListener("click", () => { if (shop.page < shop.data?.totalPages) void loadCatalog(shop.page + 1); });
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
  if (tab === "trackers" && !document.hidden && !get("tracker-dialog").open) void loadTrackers();
}, 15_000);
addEventListener("pageshow", event => {
  if (event.persisted) {
    showLogin("正在读取当前档案…");
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
  showLogin("正在读取当前档案…");
  if (ticket[2]) switchTab("shop");
  updateBusy(true);
  try {
    const response = await request("api/claim", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket: ticket[1] }),
    });
    if (!response.ok) {
      showLogin("登录链接已失效，请在聊天中重新获取。", true);
      return;
    }
  } catch {
    showLogin("无法确认登录结果，请刷新或在聊天中重新获取链接。", true, true);
    return;
  } finally {
    updateBusy(false);
  }
  return refresh();
}

addEventListener("hashchange", () => { if (location.hash.startsWith("#ticket=")) void connect(); });
void connect();
