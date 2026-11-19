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
  resetShop();
  switchTab("overview");
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
  for (const name of ["overview", "shop"]) {
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

function detailContent({ good, roles, roleError }) {
  const blocks = [add("h3", "", good.name), statusBadge(good.status),
    add("p", "shop-price", point(good.price) + " 米游币"), shopFacts(good, true),
    add("h4", "", "兑换条件"), add("p", "detail-copy", good.requirements || "官方暂未提供额外兑换说明。")];
  if (good.type === 1) blocks.push(add("p", "muted", "实物商品需要米游社收货地址。"));
  if (good.type !== 2) return blocks;
  blocks.push(add("h4", "", "当前档案绑定的角色"));
  if (roleError || !roles.length) {
    blocks.push(add("p", "muted", roleError || "没有找到此商品对应的绑定角色。"));
    return blocks;
  }
  const list = add("ul", "rows", "");
  for (const role of roles) {
    const row = add("li", "role-row", "");
    const identity = [role.nickname || "角色", role.regionName || role.region, role.level ? "Lv." + role.level : ""]
      .filter(Boolean).join(" · ");
    row.append(add("span", "", identity), add("span", "muted", "UID " + role.uid));
    list.append(row);
  }
  blocks.push(list, add("p", "muted", "实际兑换条件请以米游社商品说明为准。"));
  return blocks;
}

async function openDetail(id) {
  shop.detailRequest?.abort();
  const controller = new AbortController();
  shop.detailRequest = controller;
  const dialog = get("shop-detail"), content = get("shop-detail-content");
  content.replaceChildren(add("p", "muted", "正在读取商品详情…"));
  if (!dialog.open) dialog.showModal();
  try {
    const response = await shopRequest("api/goods/" + encodeURIComponent(id), controller);
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
    showOverview(await response.json());
    showNotice("");
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

get("refresh").addEventListener("click", () => void (tab === "shop" ? loadCatalog() : refresh()));
get("login-retry").addEventListener("click", refresh);
get("logout").addEventListener("click", logout);
get("tab-overview").addEventListener("click", () => switchTab("overview"));
get("tab-shop").addEventListener("click", () => {
  switchTab("shop");
  if (!shop.data && !shop.catalogRequest) void loadCatalog();
});
get("shop-game").addEventListener("change", event => void loadCatalog(1, event.target.value));
get("shop-status").addEventListener("change", renderGoods);
get("shop-search").addEventListener("input", renderGoods);
get("shop-previous").addEventListener("click", () => { if (shop.page > 1) void loadCatalog(shop.page - 1); });
get("shop-next").addEventListener("click", () => { if (shop.page < shop.data?.totalPages) void loadCatalog(shop.page + 1); });
get("shop-close").addEventListener("click", () => get("shop-detail").close());
get("shop-detail").addEventListener("close", () => shop.detailRequest?.abort());
setInterval(() => {
  if (!get("dashboard").hidden) get("clock").textContent = clock.format();
  if (tab === "shop") tickShop();
}, 1000);
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
