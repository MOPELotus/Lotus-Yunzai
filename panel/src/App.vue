<script setup lang="ts">
import { panelText, panelLanguage, requestPanelLanguage } from './i18n.ts';

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
import I18nSettings from "./I18nSettings.vue";

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
  "account-permissions" | "global-permissions" | "i18n" | MediaView | "extensions";
const view = ref<PanelView>("overview");
const mediaSection = ref<MediaView>("bilibili");
const viewingMedia = computed(() => isMediaView(view.value));
const settingsDirty = ref(false);
const discardTo = ref<PanelView>();
const clock = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

const shanghaiTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
let sessionTimer: ReturnType<typeof setTimeout> | undefined;
let sessionDeadline: number | undefined;
let auth: PanelAuth = browserSession;
let activeRequest: AbortController | undefined;
let activeLogout: AbortController | undefined;
const extensionPreferences = new Map<string, string>();

const hasGroup = computed(() => snapshot.value?.plugins.some((plugin) =>
  plugin.name === "group" && plugin.status === "loaded") ?? false);

const hasMedia = computed(() => snapshot.value?.plugins.some((plugin) =>
  plugin.name === "media" && plugin.status === "loaded") ?? false);

const nativeSections = computed(() => [
  { key: "rank", label: panelText('App.fd19f63382') },
  { key: "ark-rank-credentials", label: panelText('App.ce7067d3c9') },
  { key: "status", label: panelText('App.1ccd867a7e') },
  { key: "runtime", label: panelText('App.0b3fc02f29') },
  { key: "remote", label: panelText('App.42db987eee') },
  { key: "process-schedule", label: panelText('App.5ae3df2876') },
  { key: "showcase", label: panelText('App.2d29780c70') },
  { key: "genshin-damage", label: panelText('App.fdf1872068') },
  { key: "starrail-warp", label: panelText('App.739afb8575') },
  { key: "starrail-independent-warp", label: panelText('App.e94f6f21a3') },
  { key: "gacha-display", label: panelText('App.80b23e447c') },
  { key: "genshin-wish", label: panelText('App.93123d3162') },
  { key: "zzz-rank", label: panelText('App.e8bca90321') },
  { key: "zzz-panel", label: panelText('App.1a4b99303b') },
  { key: "zzz-reminders", label: panelText('App.fa816183af') },
  { key: "daily-note", label: panelText('App.60983f084c') },
  { key: "ingress", label: panelText('App.a382f9c04c') },
  { key: "group-routing", label: panelText('App.672fc8e301') },
  { key: "guides", label: panelText('App.5fcf079e33') },
  { key: "genshin-guides", label: panelText('App.2c9f240951') },
  { key: "starrail-guides", label: panelText('App.ff08b27837') },
  { key: "zzz-guides", label: panelText('App.43fbe5348d') },
  { key: "calendar", label: panelText('App.6f20ee0d82') },
  { key: "notice", label: panelText('App.cfd772e1f0') },
  { key: "mys-notice", label: panelText('App.5d56880517') },
  { key: "notice-delivery", label: panelText('App.a85da0ae4a') },
  ...(hasGroup.value ? [{ key: "group-moderation", label: panelText('App.d09b255ab4') },
    { key: "group-card", label: panelText('App.7473450ca8') }, { key: "group-leave-blacklist", label: panelText('App.6995adc637') }] : []),
  ...(hasMedia.value ? [{ key: "bilibili-subscriptions", label: panelText('App.fc031bad16') },
    { key: "weibo-subscriptions", label: panelText('App.71429cd3b0') }] : []),
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
    i18n: "i18n-settings-title",
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
  error.value = panelText('App.b580e22fb1');
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
    [Math.floor(seconds / 86_400), panelText('App.49da61ceee')],
    [Math.floor(seconds / 3_600) % 24, panelText('App.3b6fefc50f')],
    [Math.floor(seconds / 60) % 60, panelText('App.bd957bc497')],
  ] as const;
  return units.filter(([value]) => value > 0).map(([value, label]) => `${value} ${label}`).join(" ") ||
    panelText('App.8e9c8e4d3e', { value1: seconds });
}

function checkSessionExpiry() {
  clearTimeout(sessionTimer);
  if (sessionDeadline === undefined) return;
  const remaining = sessionDeadline - Date.now();
  if (remaining <= 0) expireSession();
  else sessionTimer = setTimeout(checkSessionExpiry, Math.min(remaining, 2_147_483_647));
}

function reset() {
  clearTimeout(sessionTimer);
  sessionDeadline = undefined;
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
    const previousLanguage = panelLanguage.value;
    await requestPanelLanguage(candidate, { signal: request.signal }).catch(() => undefined);
    if (previousLanguage !== panelLanguage.value) { window.location.reload(); return; }
    if (activeRequest !== request) return;

    auth = candidate;
    draft.value = "";
    snapshot.value = incoming;
    updatedAt.value = clock.format(new Date());
    sessionDeadline = incoming.session ? Date.now() + (incoming.session.expiresAt - incoming.session.now) : undefined;
    checkSessionExpiry();
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
    error.value = failure instanceof Error ? failure.message : panelText('App.0a292df77a');
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
    if (activeLogout === request) logoutError.value = panelText('App.49f9b4c50d');
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
  window.addEventListener("pageshow", checkSessionExpiry);
  document.addEventListener("visibilitychange", checkSessionExpiry);
  if (!openLinkedTicket()) void synchronize(browserSession, "restore");
});

onBeforeUnmount(() => {
  window.removeEventListener("hashchange", openLinkedTicket);
  window.removeEventListener("pageshow", checkSessionExpiry);
  document.removeEventListener("visibilitychange", checkSessionExpiry);
  clearTimeout(sessionTimer);
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
        <span>{{ panelText('App.058cedd84e') }}</span>
      </div>
      <div v-if="snapshot" class="session-actions">
        <span v-if="snapshot.session" class="session-expiry">
          {{ panelText('App.f70036fba2', { value1: shanghaiTime.format(snapshot.session.expiresAt) }) }}
        </span>
        <ElButton class="sign-out" :loading="signingOut" :disabled="busy" @click="signOut">{{ panelText('App.3ab8cc1593') }}</ElButton>
      </div>
    </div>
  </header>

  <main v-if="restoring" class="sign-in" aria-busy="true">
    <section class="sign-in-card" role="status">{{ panelText('App.fd0ddccc89') }}</section>
  </main>

  <main v-else-if="!snapshot" class="sign-in">
    <section class="sign-in-card" aria-labelledby="signin-title">
      <h1 id="signin-title">{{ panelText('App.0d33bea8e6') }}</h1>
      <p>{{ panelText('App.e64719b784') }} <code>{{ panelText('App.37989c2980') }}</code> {{ panelText('App.64cf1143b1') }}</p>
      <form autocomplete="off" @submit.prevent="signInWithToken">
        <label for="panel-token">{{ panelText('App.9b9fc2fad9') }}</label>
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
        <ElButton type="primary" native-type="submit" :loading="busy" :disabled="!draft.trim()">{{ panelText('App.1e2df9c307') }}</ElButton>
      </form>
    </section>
  </main>

  <main v-else class="dashboard" :inert="signingOut">
    <p v-if="logoutError" class="error refresh-error" role="alert">{{ logoutError }}</p>
    <nav class="panel-nav" :aria-label="panelText('App.1e0c0dd3d1')">
      <ElButton :type="view === 'overview' ? 'primary' : 'default'"
        :aria-current="view === 'overview' ? 'page' : undefined" @click="setView('overview')">{{ panelText('App.17826325a8') }}</ElButton>
      <ElButton v-if="hasGroup" :type="view === 'likes' ? 'primary' : 'default'"
        :aria-current="view === 'likes' ? 'page' : undefined" @click="setView('likes')">{{ panelText('App.7ed843b349') }}</ElButton>
      <ElButton v-if="hasGroup" :type="view === 'notices' ? 'primary' : 'default'"
        :aria-current="view === 'notices' ? 'page' : undefined" @click="setView('notices')">{{ panelText('App.a6d489ae13') }}</ElButton>
      <ElButton :type="view === 'native-settings' ? 'primary' : 'default'"
        :aria-current="view === 'native-settings' ? 'page' : undefined" @click="setView('native-settings')">{{ panelText('App.e10d1b5bcf') }}</ElButton>
      <ElButton :type="view === 'plugin-settings' ? 'primary' : 'default'"
        :aria-current="view === 'plugin-settings' ? 'page' : undefined" @click="setView('plugin-settings')">{{ panelText('App.f782650891') }}</ElButton>
      <ElButton :type="view === 'atlas' ? 'primary' : 'default'"
        :aria-current="view === 'atlas' ? 'page' : undefined" @click="setView('atlas')">{{ panelText('App.eda98902b2') }}</ElButton>
      <ElButton :type="view === 'web-login' ? 'primary' : 'default'"
        :aria-current="view === 'web-login' ? 'page' : undefined" @click="setView('web-login')">{{ panelText('App.658333c8c7') }}</ElButton>
      <ElButton :type="view === 'checkin-schedule' ? 'primary' : 'default'"
        :aria-current="view === 'checkin-schedule' ? 'page' : undefined" @click="setView('checkin-schedule')">{{ panelText('App.fb3da8820b') }}</ElButton>
      <ElButton :type="view === 'account-permissions' ? 'primary' : 'default'"
        :aria-current="view === 'account-permissions' ? 'page' : undefined" @click="setView('account-permissions')">{{ panelText('App.cd4bf18b7e') }}</ElButton>
      <ElButton :type="view === 'global-permissions' ? 'primary' : 'default'"
        :aria-current="view === 'global-permissions' ? 'page' : undefined" @click="setView('global-permissions')">{{ panelText('App.3b3f45b021') }}</ElButton>
      <ElButton v-if="hasMedia" :type="viewingMedia ? 'primary' : 'default'"
        :aria-current="viewingMedia ? 'true' : undefined" @click="setView(mediaSection)">{{ panelText('App.f9a9e5236d') }}</ElButton>
      <ElButton :type="view === 'extensions' ? 'primary' : 'default'"
        :aria-current="view === 'extensions' ? 'page' : undefined" @click="setView('extensions')">{{ panelText('App.eccf12cef9') }}</ElButton>
      <ElButton :type="view === 'i18n' ? 'primary' : 'default'"
        :aria-current="view === 'i18n' ? 'page' : undefined" @click="setView('i18n')">{{ panelText('App.c1c579a974') }}</ElButton>
    </nav>
    <nav v-if="hasMedia && viewingMedia" class="panel-nav media-nav" :aria-label="panelText('App.f9a9e5236d')">
      <ElButton :type="view === 'bilibili' ? 'primary' : 'default'"
        :aria-current="view === 'bilibili' ? 'page' : undefined" @click="setView('bilibili')">{{ panelText('App.be20b1c3ef') }}</ElButton>
      <ElButton :type="view === 'douyin' ? 'primary' : 'default'"
        :aria-current="view === 'douyin' ? 'page' : undefined" @click="setView('douyin')">{{ panelText('App.d077d0b18e') }}</ElButton>
      <ElButton :type="view === 'music' ? 'primary' : 'default'"
        :aria-current="view === 'music' ? 'page' : undefined" @click="setView('music')">{{ panelText('App.a0c46fa3bd') }}</ElButton>
      <ElButton :type="view === 'partner' ? 'primary' : 'default'"
        :aria-current="view === 'partner' ? 'page' : undefined" @click="setView('partner')">{{ panelText('App.cd6483cb47') }}</ElButton>
      <ElButton :type="view === 'media-environment' ? 'primary' : 'default'"
        :aria-current="view === 'media-environment' ? 'page' : undefined" @click="setView('media-environment')">{{ panelText('App.22eeda2814') }}</ElButton>
    </nav>
    <div v-if="discardTo" class="panel-discard" role="alert">
      <span>{{ panelText('App.b512d06f0c') }}</span>
      <ElButton id="panel-continue-editing" @click="continueEditing">{{ panelText('App.fd4b9e3b6c') }}</ElButton>
      <ElButton type="danger" @click="setView(discardTo!, true)">{{ panelText('App.9d14d6e3fd') }}</ElButton>
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
    <I18nSettings v-else-if="view === 'i18n'" :auth="auth" @unauthorized="expireSession" @dirty-change="updateDirty" />
    <ExtensionPages v-else-if="view === 'extensions'" :auth="auth" :preferences="extensionPreferences"
      @unauthorized="expireSession" />
    <template v-else>
      <section aria-labelledby="overview-title" :aria-busy="busy">
        <div class="section-heading">
          <div>
            <h1 id="overview-title" tabindex="-1">{{ panelText('App.17826325a8') }}</h1>
            <p class="subtitle">{{ snapshot.runtime.name }}</p>
          </div>
          <ElButton :loading="busy" :disabled="signingOut" @click="synchronize(auth, 'refresh')">{{ panelText('App.0468ee76ee') }}</ElButton>
        </div>

        <p v-if="error" class="error refresh-error" role="alert">{{ panelText('App.f3792e5475', { value1: error }) }}</p>

        <dl class="metrics">
          <div>
            <dt>{{ panelText('App.e46b0272bd') }}</dt>
            <dd class="runtime-status" :class="{ online: snapshot.runtime.status === 'ok' }">
              <span aria-hidden="true"></span>
              {{ snapshot.runtime.status === "ok" ? panelText('App.1f0eb99b7e') : snapshot.runtime.status }}
            </dd>
          </div>
          <div>
            <dt>{{ panelText('App.b1e3a96e54') }}</dt>
            <dd>{{ duration(snapshot.runtime.uptime) }}</dd>
          </div>
          <div>
            <dt>{{ panelText('App.1287cd7bae') }}</dt>
            <dd class="technical">{{ snapshot.runtime.bun }}</dd>
          </div>
        </dl>
      </section>

      <section class="plugins" aria-labelledby="plugins-title" :aria-busy="busy">
        <div class="plugins-heading">
          <h2 id="plugins-title">{{ panelText('App.2f64470077') }}</h2>
          <p class="updated" role="status">{{ panelText('App.f987642f0d', { value1: updatedAt }) }}</p>
        </div>

        <div v-if="snapshot.plugins.length" class="filters">
          <label for="plugin-search" class="visually-hidden">{{ panelText('App.44891fe35f') }}</label>
          <ElInput id="plugin-search" v-model="query" :placeholder="panelText('App.44891fe35f')" />
          <label for="plugin-status" class="visually-hidden">{{ panelText('App.df92cab4c6') }}</label>
          <select id="plugin-status" v-model="selectedStatus">
            <option value="">{{ panelText('App.0a379c1e73') }}</option>
            <option v-for="(label, status) in pluginStatuses" :key="status" :value="status">{{ label }}</option>
          </select>
        </div>

        <div v-if="visiblePlugins.length" class="plugin-results">
          <table aria-labelledby="plugins-title">
            <thead>
              <tr><th scope="col">{{ panelText('App.e806fbbe8e') }}</th><th scope="col">{{ panelText('App.6320b4a872') }}</th><th scope="col">{{ panelText('App.4262c45dc7') }}</th></tr>
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
        <p v-else class="empty" role="status">{{ snapshot.plugins.length ? panelText('App.b77a7a928c') : panelText('App.9bee9df502') }}</p>
      </section>
    </template>
  </main>
</template>

<style scoped>
.session-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 6px 12px;
}

.session-expiry {
  color: var(--muted);
  font-size: 13px;
}

@media (max-width: 640px) {
  .header-inner:has(.session-expiry) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px 16px;
    padding-block: 10px;
  }

  .session-actions { display: contents; }
  .session-expiry { grid-area: 2 / 1 / 3 / -1; }
  .sign-out { grid-area: 1 / 2 / 2 / 3; }
}
</style>
