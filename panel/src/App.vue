<script setup lang="ts">
import { ElButton, ElInput } from "element-plus";
import { computed, nextTick, onBeforeUnmount, ref, shallowRef } from "vue";
import { CredentialsError, pluginStatuses, readPanel, type PanelSnapshot, type PluginStatus } from "./api.ts";
import ExtensionPages from "./ExtensionPages.vue";
import PluginSettings from "./PluginSettings.vue";
import LikeSettings from "./LikeSettings.vue";
import GroupNoticeSettings from "./GroupNoticeSettings.vue";
import AtlasChannelSettings from "./AtlasChannelSettings.vue";

const draft = ref("");
const snapshot = shallowRef<PanelSnapshot>();
const busy = ref(false);
const error = ref("");
const updatedAt = ref("");
const query = ref("");
const selectedStatus = ref<PluginStatus | "">("");
type PanelView = "overview" | "likes" | "notices" | "plugin-settings" | "atlas" | "extensions";
const view = ref<PanelView>("overview");
const settingsDirty = ref(false);
const discardTo = ref<PanelView>();
const clock = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

let token = "";
let activeRequest: AbortController | undefined;
const extensionPreferences = new Map<string, string>();

const hasGroup = computed(() => snapshot.value?.plugins.some((plugin) =>
  plugin.name === "group" && plugin.status === "loaded") ?? false);

function setView(next: PanelView, discard = false) {
  if (view.value === next) return;
  if (settingsDirty.value && !discard) {
    discardTo.value = next;
    return;
  }
  settingsDirty.value = false;
  discardTo.value = undefined;
  view.value = next;
  const heading = {
    overview: "overview-title",
    likes: "like-settings-title",
    notices: "group-notice-settings-title",
    "plugin-settings": "plugin-settings-title",
    atlas: "atlas-channel-title",
    extensions: "extensions-title",
  }[next];
  void nextTick(() => document.getElementById(heading)?.focus());
}

function expireSession() {
  reset();
  error.value = "面板令牌已失效，请重新登录。";
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
  token = "";
  extensionPreferences.clear();
  draft.value = "";
  snapshot.value = undefined;
  busy.value = false;
  error.value = "";
  updatedAt.value = "";
  query.value = "";
  selectedStatus.value = "";
  view.value = "overview";
  settingsDirty.value = false;
  discardTo.value = undefined;
  void nextTick(() => document.getElementById("panel-token")?.focus());
}

async function synchronize(candidate: string, signingIn: boolean) {
  if (busy.value || !candidate) return;

  const request = new AbortController();
  const timeout = setTimeout(() => request.abort(), 10_000);
  activeRequest = request;
  busy.value = true;
  error.value = "";
  try {
    const incoming = await readPanel(candidate, request.signal);
    if (activeRequest !== request) return;

    token = candidate;
    draft.value = "";
    snapshot.value = incoming;
    updatedAt.value = clock.format(new Date());
    if (signingIn) await nextTick(() => document.getElementById("overview-title")?.focus());
  } catch (failure) {
    if (activeRequest !== request) return;

    if (failure instanceof CredentialsError && !signingIn) reset();
    error.value = failure instanceof Error ? failure.message : "读取面板时发生错误。";
  } finally {
    clearTimeout(timeout);
    if (activeRequest === request) {
      activeRequest = undefined;
      busy.value = false;
    }
  }
}

onBeforeUnmount(() => {
  activeRequest?.abort();
  activeRequest = undefined;
  token = "";
});
</script>

<template>
  <header class="header">
    <div class="header-inner">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>Lotus-Yunzai 管理面板</span>
      </div>
      <ElButton v-if="snapshot" class="sign-out" @click="reset">退出登录</ElButton>
    </div>
  </header>

  <main v-if="!snapshot" class="sign-in">
    <section class="sign-in-card" aria-labelledby="signin-title">
      <h1 id="signin-title">登录面板</h1>
      <p>请输入宿主配置的面板令牌。</p>
      <form autocomplete="off" @submit.prevent="synchronize(draft.trim(), true)">
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

  <main v-else class="dashboard">
    <nav class="panel-nav" aria-label="面板页面">
      <ElButton :type="view === 'overview' ? 'primary' : 'default'"
        :aria-current="view === 'overview' ? 'page' : undefined" @click="setView('overview')">运行概览</ElButton>
      <ElButton v-if="hasGroup" :type="view === 'likes' ? 'primary' : 'default'"
        :aria-current="view === 'likes' ? 'page' : undefined" @click="setView('likes')">群点赞</ElButton>
      <ElButton v-if="hasGroup" :type="view === 'notices' ? 'primary' : 'default'"
        :aria-current="view === 'notices' ? 'page' : undefined" @click="setView('notices')">群通知</ElButton>
      <ElButton :type="view === 'plugin-settings' ? 'primary' : 'default'"
        :aria-current="view === 'plugin-settings' ? 'page' : undefined" @click="setView('plugin-settings')">插件配置</ElButton>
      <ElButton :type="view === 'atlas' ? 'primary' : 'default'"
        :aria-current="view === 'atlas' ? 'page' : undefined" @click="setView('atlas')">图鉴设置</ElButton>
      <ElButton :type="view === 'extensions' ? 'primary' : 'default'"
        :aria-current="view === 'extensions' ? 'page' : undefined" @click="setView('extensions')">扩展页面</ElButton>
    </nav>
    <div v-if="discardTo" class="panel-discard" role="alert">
      <span>当前配置还有未保存的改动。</span>
      <ElButton @click="discardTo = undefined">继续编辑</ElButton>
      <ElButton type="danger" @click="setView(discardTo!, true)">放弃改动</ElButton>
    </div>
    <LikeSettings v-if="view === 'likes'" :token="token" @unauthorized="expireSession"
      @dirty-change="updateDirty" />
    <GroupNoticeSettings v-else-if="view === 'notices'" :token="token" @unauthorized="expireSession"
      @dirty-change="updateDirty" />
    <PluginSettings v-else-if="view === 'plugin-settings'" :token="token" @unauthorized="expireSession"
      @dirty-change="updateDirty" />
    <AtlasChannelSettings v-else-if="view === 'atlas'" :token="token" @unauthorized="expireSession"
      @dirty-change="updateDirty" />
    <ExtensionPages v-else-if="view === 'extensions'" :token="token" :preferences="extensionPreferences"
      @unauthorized="expireSession" />
    <template v-else>
      <section aria-labelledby="overview-title" :aria-busy="busy">
        <div class="section-heading">
          <div>
            <h1 id="overview-title" tabindex="-1">运行概览</h1>
            <p class="subtitle">{{ snapshot.runtime.name }}</p>
          </div>
          <ElButton :loading="busy" @click="synchronize(token, false)">刷新数据</ElButton>
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
