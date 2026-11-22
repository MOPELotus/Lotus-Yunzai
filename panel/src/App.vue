<script setup lang="ts">
import { ElButton, ElInput } from "element-plus";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import {
  browserSession, claimPanelSession, CredentialsError, logoutPanelSession, pluginStatuses, readPanel,
  type PanelAuth, type PanelSnapshot, type PluginStatus,
} from "./api.ts";
import ExtensionPages from "./ExtensionPages.vue";
import PluginSettings from "./PluginSettings.vue";
import LikeSettings from "./LikeSettings.vue";
import GroupNoticeSettings from "./GroupNoticeSettings.vue";
import BusinessSettings from "./BusinessSettings.vue";
import AtlasChannelSettings from "./AtlasChannelSettings.vue";
import WebLoginSettings from "./WebLoginSettings.vue";
import CheckinScheduleSettings from "./CheckinScheduleSettings.vue";
import AccountPermissionsSettings from "./AccountPermissionsSettings.vue";
import GlobalPermissionsSettings from "./GlobalPermissionsSettings.vue";
import MusicSettings from "./MusicSettings.vue";
import BilibiliSettings from "./BilibiliSettings.vue";
import DouyinSettings from "./DouyinSettings.vue";
import PartnerSettings from "./PartnerSettings.vue";
import MediaEnvironmentSettings from "./MediaEnvironmentSettings.vue";

const draft = ref("");
const snapshot = shallowRef<PanelSnapshot>();
const restoring = ref(true);
const busy = ref(false);
const signingOut = ref(false);
const error = ref("");
const logoutError = ref("");
const updatedAt = ref("");
const query = ref("");
const selectedStatus = ref<PluginStatus | "">("");
type MediaView = "music" | "bilibili" | "douyin" | "partner" | "media-environment";
type PanelView = "overview" | "likes" | "notices" | "native-settings" | "plugin-settings" | "atlas" | "web-login" | "checkin-schedule" |
  "account-permissions" | "global-permissions" | MediaView | "extensions";
const view = ref<PanelView>("overview");
const mediaSection = ref<MediaView>("bilibili");
const viewingMedia = computed(() => isMediaView(view.value));
const settingsDirty = ref(false);
const discardTo = ref<PanelView>();
const clock = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

let auth: PanelAuth = browserSession;
let activeRequest: AbortController | undefined;
let activeLogout: AbortController | undefined;
const extensionPreferences = new Map<string, string>();

const hasGroup = computed(() => snapshot.value?.plugins.some((plugin) =>
  plugin.name === "group" && plugin.status === "loaded") ?? false);

const hasMedia = computed(() => snapshot.value?.plugins.some((plugin) =>
  plugin.name === "media" && plugin.status === "loaded") ?? false);

const nativeSections = computed(() => [
  { key: "rank", label: "原神与星铁群榜" },
  { key: "status", label: "状态与监控" },
  { key: "runtime", label: "宿主运行" },
  { key: "process-schedule", label: "停启与更新调度" },
  { key: "showcase", label: "游戏展柜与战绩" },
  { key: "genshin-damage", label: "原神伤害计算" },
  { key: "zzz-rank", label: "绝区零群榜" },
  { key: "zzz-panel", label: "绝区零面板刷新" },
  { key: "zzz-reminders", label: "绝区零挑战提醒" },
  { key: "daily-note", label: "游戏体力提醒" },
  { key: "ingress", label: "消息接收与私聊" },
  { key: "guides", label: "攻略来源与推送" },
  { key: "genshin-guides", label: "原神攻略" },
  { key: "zzz-guides", label: "绝区零攻略" },
  { key: "calendar", label: "活动日历" },
  { key: "notice", label: "群公告调度" },
  { key: "mys-notice", label: "米游社资讯" },
  { key: "notice-delivery", label: "公告送达与订阅覆盖" },
  ...(hasGroup.value ? [{ key: "group-moderation", label: "群管权限与入群" },
    { key: "group-card", label: "自动群名片" }, { key: "group-leave-blacklist", label: "退群拉黑" }] : []),
  ...(hasMedia.value ? [{ key: "bilibili-subscriptions", label: "B 站订阅对象" },
    { key: "weibo-subscriptions", label: "微博订阅对象" }] : []),
]);

function isMediaView(target: PanelView): target is MediaView {
  return target === "music" || target === "bilibili" || target === "douyin" || target === "partner" || target === "media-environment";
}

function setView(next: PanelView, discard = false) {
  if (view.value === next) return;
  if (settingsDirty.value && !discard) {
    discardTo.value = next;
    void nextTick(() => {
      if (discardTo.value === next) document.getElementById("panel-continue-editing")?.focus();
    });
    return;
  }
  settingsDirty.value = false;
  discardTo.value = undefined;
  view.value = next;
  if (isMediaView(next)) mediaSection.value = next;
  focusView(next);
}

function continueEditing() {
  discardTo.value = undefined;
  focusView(view.value);
}

function focusView(next: PanelView) {
  const heading = {
    overview: "overview-title",
    likes: "like-settings-title",
    notices: "group-notice-settings-title",
    "native-settings": "native-settings-title",
    "plugin-settings": "plugin-settings-title",
    atlas: "atlas-channel-title",
    "web-login": "web-login-title",
    "checkin-schedule": "checkin-schedule-title",
    "account-permissions": "account-permissions-title",
    "global-permissions": "global-permissions-title",
    music: "music-settings-title",
    bilibili: "bilibili-settings-title",
    douyin: "douyin-settings-title",
    partner: "partner-settings-title",
    "media-environment": "media-environment-title",
    extensions: "extensions-title",
  }[next];
  void nextTick(() => document.getElementById(heading)?.focus());
}

function expireSession() {
  reset();
  error.value = "面板登录已失效，请重新登录。";
}

function updateDirty(dirty: boolean) {
  settingsDirty.value = dirty;
  if (!dirty) discardTo.value = undefined;
}

const visiblePlugins = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  return (snapshot.value?.plugins ?? []).filter((plugin) =>
    (!selectedStatus.value || plugin.status === selectedStatus.value) &&
    (!keyword || plugin.name.toLowerCase().includes(keyword) || plugin.reason?.toLowerCase().includes(keyword)));
});

function duration(seconds: number): string {
  const units = [
    [Math.floor(seconds / 86_400), "天"],
    [Math.floor(seconds / 3_600) % 24, "小时"],
    [Math.floor(seconds / 60) % 60, "分钟"],
  ] as const;
  return units.filter(([value]) => value > 0).map(([value, label]) => `${value} ${label}`).join(" ") ||
    `${seconds} 秒`;
}

function reset() {
  activeRequest?.abort();
  activeRequest = undefined;
  auth = browserSession;
  extensionPreferences.clear();
  draft.value = "";
  snapshot.value = undefined;
  busy.value = false;
  error.value = "";
  logoutError.value = "";
  updatedAt.value = "";
  query.value = "";
  selectedStatus.value = "";
  view.value = "overview";
  settingsDirty.value = false;
  discardTo.value = undefined;
  void nextTick(() => document.getElementById("panel-token")?.focus());
}

async function synchronize(candidate: PanelAuth, purpose: "restore" | "sign-in" | "refresh", ticket?: string) {
  if (busy.value || signingOut.value) return;

  const request = new AbortController();
  const timeout = setTimeout(() => request.abort(), 10_000);
  activeRequest = request;
  busy.value = true;
  error.value = "";
  try {
    if (ticket !== undefined) await claimPanelSession(ticket, request.signal);
    const incoming = await readPanel(candidate, request.signal);
    if (activeRequest !== request) return;

    auth = candidate;
    draft.value = "";
    snapshot.value = incoming;
    updatedAt.value = clock.format(new Date());
    if (purpose === "sign-in") {
      restoring.value = false;
      await nextTick(() => document.getElementById("overview-title")?.focus());
    }
  } catch (failure) {
    if (activeRequest !== request) return;

    if (failure instanceof CredentialsError) {
      if (purpose === "restore") return;
      if (purpose === "refresh") return expireSession();
    }
    error.value = failure instanceof Error ? failure.message : "读取面板时发生错误。";
  } finally {
    clearTimeout(timeout);
    if (activeRequest === request) {
      activeRequest = undefined;
      busy.value = false;
      restoring.value = false;
    }
  }
}

function signInWithToken() {
  const token = draft.value.trim();
  if (token) return synchronize({ kind: "bearer", token }, "sign-in");
}

async function signOut() {
  if (signingOut.value) return;
  if (auth.kind === "bearer") return reset();

  const request = new AbortController();
  activeLogout = request;
  signingOut.value = true;
  logoutError.value = "";
  try {
    await logoutPanelSession(AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]));
    if (activeLogout === request) reset();
  } catch {
    if (activeLogout === request) logoutError.value = "未能确认退出登录，请重试。";
  } finally {
    if (activeLogout === request) {
      activeLogout = undefined;
      signingOut.value = false;
      openLinkedTicket();
    }
  }
}

function openLinkedTicket() {
  if (signingOut.value) return false;
  const url = new URL(window.location.href);
  const tickets = new URLSearchParams(url.hash.slice(1)).getAll("ticket");
  if (!tickets.length) return false;
  window.history.replaceState(window.history.state, "", url.pathname + url.search);
  reset();
  restoring.value = true;
  void synchronize(browserSession, "sign-in", tickets.length === 1 ? tickets[0]! : "");
  return true;
}

onMounted(() => {
  window.addEventListener("hashchange", openLinkedTicket);
  if (!openLinkedTicket()) void synchronize(browserSession, "restore");
});

onBeforeUnmount(() => {
  window.removeEventListener("hashchange", openLinkedTicket);
  activeRequest?.abort();
  activeRequest = undefined;
  activeLogout?.abort();
  activeLogout = undefined;
  auth = browserSession;
});
</script>

<template>
  <header class="header">
    <div class="header-inner">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>Lotus-Yunzai 管理面板</span>
      </div>
      <ElButton v-if="snapshot" class="sign-out" :loading="signingOut" :disabled="busy" @click="signOut">退出登录</ElButton>
    </div>
  </header>

  <main v-if="restoring" class="sign-in" aria-busy="true">
    <section class="sign-in-card" role="status">正在检查登录状态…</section>
  </main>

  <main v-else-if="!snapshot" class="sign-in">
    <section class="sign-in-card" aria-labelledby="signin-title">
      <h1 id="signin-title">登录面板</h1>
      <p>机器人主人可私聊发送 <code>#管理面板</code> 获取登录链接，也可使用宿主配置的面板令牌。</p>
      <form autocomplete="off" @submit.prevent="signInWithToken">
        <label for="panel-token">面板令牌</label>
        <ElInput
          id="panel-token"
          v-model="draft"
          type="password"
          autocomplete="new-password"
          required
          :disabled="busy"
          :aria-invalid="Boolean(error)"
          :aria-describedby="error ? 'signin-error' : undefined"
        />
        <p v-if="error" id="signin-error" class="error" role="alert">{{ error }}</p>
        <ElButton type="primary" native-type="submit" :loading="busy" :disabled="!draft.trim()">登录</ElButton>
      </form>
    </section>
  </main>

  <main v-else class="dashboard" :inert="signingOut">
    <p v-if="logoutError" class="error refresh-error" role="alert">{{ logoutError }}</p>
    <nav class="panel-nav" aria-label="面板页面">
      <ElButton :type="view === 'overview' ? 'primary' : 'default'"
        :aria-current="view === 'overview' ? 'page' : undefined" @click="setView('overview')">运行概览</ElButton>
      <ElButton v-if="hasGroup" :type="view === 'likes' ? 'primary' : 'default'"
        :aria-current="view === 'likes' ? 'page' : undefined" @click="setView('likes')">群点赞</ElButton>
      <ElButton v-if="hasGroup" :type="view === 'notices' ? 'primary' : 'default'"
        :aria-current="view === 'notices' ? 'page' : undefined" @click="setView('notices')">群通知</ElButton>
      <ElButton :type="view === 'native-settings' ? 'primary' : 'default'"
        :aria-current="view === 'native-settings' ? 'page' : undefined" @click="setView('native-settings')">业务设置</ElButton>
      <ElButton :type="view === 'plugin-settings' ? 'primary' : 'default'"
        :aria-current="view === 'plugin-settings' ? 'page' : undefined" @click="setView('plugin-settings')">插件配置</ElButton>
      <ElButton :type="view === 'atlas' ? 'primary' : 'default'"
        :aria-current="view === 'atlas' ? 'page' : undefined" @click="setView('atlas')">图鉴设置</ElButton>
      <ElButton :type="view === 'web-login' ? 'primary' : 'default'"
        :aria-current="view === 'web-login' ? 'page' : undefined" @click="setView('web-login')">网页登录</ElButton>
      <ElButton :type="view === 'checkin-schedule' ? 'primary' : 'default'"
        :aria-current="view === 'checkin-schedule' ? 'page' : undefined" @click="setView('checkin-schedule')">签到调度</ElButton>
      <ElButton :type="view === 'account-permissions' ? 'primary' : 'default'"
        :aria-current="view === 'account-permissions' ? 'page' : undefined" @click="setView('account-permissions')">签到权限</ElButton>
      <ElButton :type="view === 'global-permissions' ? 'primary' : 'default'"
        :aria-current="view === 'global-permissions' ? 'page' : undefined" @click="setView('global-permissions')">业务权限</ElButton>
      <ElButton v-if="hasMedia" :type="viewingMedia ? 'primary' : 'default'"
        :aria-current="viewingMedia ? 'true' : undefined" @click="setView(mediaSection)">媒体设置</ElButton>
      <ElButton :type="view === 'extensions' ? 'primary' : 'default'"
        :aria-current="view === 'extensions' ? 'page' : undefined" @click="setView('extensions')">扩展页面</ElButton>
    </nav>
    <nav v-if="hasMedia && viewingMedia" class="panel-nav media-nav" aria-label="媒体设置">
      <ElButton :type="view === 'bilibili' ? 'primary' : 'default'"
        :aria-current="view === 'bilibili' ? 'page' : undefined" @click="setView('bilibili')">B 站视频</ElButton>
      <ElButton :type="view === 'douyin' ? 'primary' : 'default'"
        :aria-current="view === 'douyin' ? 'page' : undefined" @click="setView('douyin')">抖音</ElButton>
      <ElButton :type="view === 'music' ? 'primary' : 'default'"
        :aria-current="view === 'music' ? 'page' : undefined" @click="setView('music')">点歌</ElButton>
      <ElButton :type="view === 'partner' ? 'primary' : 'default'"
        :aria-current="view === 'partner' ? 'page' : undefined" @click="setView('partner')">网易云合伙人</ElButton>
      <ElButton :type="view === 'media-environment' ? 'primary' : 'default'"
        :aria-current="view === 'media-environment' ? 'page' : undefined" @click="setView('media-environment')">媒体环境</ElButton>
    </nav>
    <div v-if="discardTo" class="panel-discard" role="alert">
      <span>当前配置还有未保存的改动。</span>
      <ElButton id="panel-continue-editing" @click="continueEditing">继续编辑</ElButton>
      <ElButton type="danger" @click="setView(discardTo!, true)">放弃改动</ElButton>
    </div>
    <LikeSettings v-if="view === 'likes'" :auth="auth" @unauthorized="expireSession"
      @dirty-change="updateDirty" />
    <GroupNoticeSettings v-else-if="view === 'notices'" :auth="auth" @unauthorized="expireSession"
      @dirty-change="updateDirty" />
    <BusinessSettings v-else-if="view === 'native-settings'" :auth="auth" :sections="nativeSections"
      @unauthorized="expireSession" @dirty-change="updateDirty" />
    <PluginSettings v-else-if="view === 'plugin-settings'" :auth="auth" @unauthorized="expireSession"
      @dirty-change="updateDirty" />
    <AtlasChannelSettings v-else-if="view === 'atlas'" :auth="auth" @unauthorized="expireSession"
      @dirty-change="updateDirty" />
    <WebLoginSettings v-else-if="view === 'web-login'" :auth="auth" @unauthorized="expireSession"
      @dirty-change="updateDirty" />
    <CheckinScheduleSettings v-else-if="view === 'checkin-schedule'" :auth="auth" @unauthorized="expireSession"
      @dirty-change="updateDirty" />
    <AccountPermissionsSettings v-else-if="view === 'account-permissions'" :auth="auth" @unauthorized="expireSession"
      @dirty-change="updateDirty" />
    <GlobalPermissionsSettings v-else-if="view === 'global-permissions'" :auth="auth" @unauthorized="expireSession"
      @dirty-change="updateDirty" />
    <MusicSettings v-else-if="view === 'music'" :auth="auth" @unauthorized="expireSession"
      @dirty-change="updateDirty" />
    <BilibiliSettings v-else-if="view === 'bilibili'" :auth="auth" @unauthorized="expireSession"
      @dirty-change="updateDirty" />
    <DouyinSettings v-else-if="view === 'douyin'" :auth="auth" @unauthorized="expireSession"
      @dirty-change="updateDirty" />
    <PartnerSettings v-else-if="view === 'partner'" :auth="auth" @unauthorized="expireSession"
      @dirty-change="updateDirty" />
    <MediaEnvironmentSettings v-else-if="view === 'media-environment'" :auth="auth" @unauthorized="expireSession"
      @dirty-change="updateDirty" />
    <ExtensionPages v-else-if="view === 'extensions'" :auth="auth" :preferences="extensionPreferences"
      @unauthorized="expireSession" />
    <template v-else>
      <section aria-labelledby="overview-title" :aria-busy="busy">
        <div class="section-heading">
          <div>
            <h1 id="overview-title" tabindex="-1">运行概览</h1>
            <p class="subtitle">{{ snapshot.runtime.name }}</p>
          </div>
          <ElButton :loading="busy" :disabled="signingOut" @click="synchronize(auth, 'refresh')">刷新数据</ElButton>
        </div>

        <p v-if="error" class="error refresh-error" role="alert">{{ error }} 当前仍显示上次读取的数据。</p>

        <dl class="metrics">
          <div>
            <dt>运行状态</dt>
            <dd class="runtime-status" :class="{ online: snapshot.runtime.status === 'ok' }">
              <span aria-hidden="true"></span>
              {{ snapshot.runtime.status === "ok" ? "运行中" : snapshot.runtime.status }}
            </dd>
          </div>
          <div>
            <dt>运行时长</dt>
            <dd>{{ duration(snapshot.runtime.uptime) }}</dd>
          </div>
          <div>
            <dt>Bun 版本</dt>
            <dd class="technical">{{ snapshot.runtime.bun }}</dd>
          </div>
        </dl>
      </section>

      <section class="plugins" aria-labelledby="plugins-title" :aria-busy="busy">
        <div class="plugins-heading">
          <h2 id="plugins-title">插件清单</h2>
          <p class="updated" role="status">更新于 {{ updatedAt }}</p>
        </div>

        <div v-if="snapshot.plugins.length" class="filters">
          <label for="plugin-search" class="visually-hidden">搜索插件</label>
          <ElInput id="plugin-search" v-model="query" placeholder="搜索插件" />
          <label for="plugin-status" class="visually-hidden">按状态筛选</label>
          <select id="plugin-status" v-model="selectedStatus">
            <option value="">全部状态</option>
            <option v-for="(label, status) in pluginStatuses" :key="status" :value="status">{{ label }}</option>
          </select>
        </div>

        <div v-if="visiblePlugins.length" class="plugin-results">
          <table aria-labelledby="plugins-title">
            <thead>
              <tr><th scope="col">插件</th><th scope="col">状态</th><th scope="col">说明</th></tr>
            </thead>
            <tbody>
              <tr v-for="plugin in visiblePlugins" :key="`${plugin.status}:${plugin.name}`">
                <th scope="row">{{ plugin.name }}</th>
                <td><span class="badge" :class="`badge-${plugin.status}`">{{ pluginStatuses[plugin.status] }}</span></td>
                <td class="reason">{{ plugin.reason ?? "—" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="empty" role="status">{{ snapshot.plugins.length ? "没有符合条件的插件。" : "当前没有插件记录。" }}</p>
      </section>
    </template>
  </main>
</template>
