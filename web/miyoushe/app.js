const get = id => document.getElementById(id);
const clock = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const expiry = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "numeric", day: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const number = new Intl.NumberFormat("zh-CN");
const games = { gs: "原神", sr: "崩坏：星穹铁道", zzz: "绝区零" };
const loginHelp = "请私聊机器人发送下方指令，获取当前档案的专属登录链接。";
let busy = false;
let pendingTicket = false;
let expiryTimer;

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
  showNotice("");
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

get("refresh").addEventListener("click", refresh);
get("login-retry").addEventListener("click", refresh);
get("logout").addEventListener("click", logout);
setInterval(() => {
  if (!get("dashboard").hidden) get("clock").textContent = clock.format();
}, 1000);
addEventListener("pageshow", event => {
  if (event.persisted) {
    showLogin("正在读取当前档案…");
    void refresh();
  }
});
async function connect() {
  const token = /^#ticket=([A-Za-z0-9_-]{43})$/u.exec(location.hash)?.[1];
  if (!token) return refresh();
  if (busy) {
    pendingTicket = true;
    return;
  }
  history.replaceState(history.state, "", location.pathname);
  updateBusy(true);
  try {
    const response = await request("api/claim", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket: token }),
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
