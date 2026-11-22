<script setup lang="ts">
import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { panelFetch, type PanelAuth } from "./api.ts";
import GroupCleanupSettings from "./GroupCleanupSettings.vue";

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{
  unauthorized: [];
  "dirty-change": [dirty: boolean];
}>();

const fields = [
  { key: "privateMessage", label: "好友消息" },
  { key: "groupMessage", label: "群消息" },
  { key: "grouptemporaryMessage", label: "群临时消息" },
  { key: "PrivateRecall", label: "好友撤回" },
  { key: "groupRecall", label: "群撤回" },
  { key: "friendRequest", label: "好友申请通知主人" },
  { key: "groupInviteRequest", label: "群邀请通知主人" },
  { key: "addGroupApplication", label: "加群申请通知主人" },
  { key: "friendNumberChange", label: "好友列表变动" },
  { key: "groupNumberChange", label: "群聊列表变动" },
  { key: "groupMemberNumberChange", label: "群成员变动" },
  { key: "groupAdminChange", label: "群管理变动" },
  { key: "botBeenBanned", label: "机器人被禁言" },
  { key: "notificationsAll", label: "向所有主人发送通知" },
] as const;
const settingsKeys = [...fields.map(({ key }) => key), "msgSaveDeltime"] as const;
const maxRetention = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);
type Settings = Record<(typeof fields)[number]["key"], boolean | null> & { msgSaveDeltime: number | null | "invalid" };
interface Snapshot {
  settings: Settings;
  revision: string;
  writable: boolean;
  scope: string;
  scopes: string[];
}

const endpoint = `${import.meta.env.BASE_URL}api/settings/group/notices`;
const selectedScope = ref("default");
const inputScope = ref("default");
const scoped = computed(() => selectedScope.value !== "default");
const validScope = computed(() => inputScope.value === "default" ||
  (/^(?:[1-9]\d*|bot:[1-9]\d*(?::[1-9]\d*)?)$/u.test(inputScope.value) &&
    inputScope.value.replace(/^bot:/u, "").split(":").every(id => Number.isSafeInteger(Number(id)))));
const baseline = shallowRef<Snapshot>();
const draft = ref<Settings>();
const busy = ref<"GET" | "PUT">();
const error = ref("");
const notice = ref("");
const conflict = ref(false);
const confirmReload = ref(false);
const confirmScope = ref<string>();
let active: AbortController | undefined;

const patch = computed(() => {
  const previous = baseline.value?.settings;
  const current = draft.value;
  if (!previous || !current) return {};
  return Object.fromEntries(settingsKeys.filter(key => previous[key] !== current[key]).map(key => [key, current[key]]));
});
const dirty = computed(() => Object.keys(patch.value).length > 0);
const validRetention = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= maxRetention;
const canSaveRetention = computed(() =>
  draft.value?.msgSaveDeltime === baseline.value?.settings.msgSaveDeltime || validRetention(draft.value?.msgSaveDeltime) ||
  (scoped.value && draft.value?.msgSaveDeltime === null));
const cleanupDirty = ref(false);
const readOnly = computed(() => baseline.value?.writable === false);
watch(dirty, (value) => {
  if (!value) confirmReload.value = false;
});
watch(() => dirty.value || cleanupDirty.value, value => emit("dirty-change", value));

function isSnapshot(value: unknown): value is Snapshot {
  if (value === null || typeof value !== "object" || !("revision" in value) ||
      typeof value.revision !== "string" || !("writable" in value) || typeof value.writable !== "boolean" ||
      !("settings" in value) || value.settings === null || typeof value.settings !== "object" ||
      !("scope" in value) || value.scope !== selectedScope.value || !("scopes" in value) ||
      !Array.isArray(value.scopes) || !value.scopes.every(scope => typeof scope === "string")) return false;

  const settings = value.settings as Record<string, unknown>;
  return fields.every(({ key }) => typeof settings[key] === "boolean" || (scoped.value && settings[key] === null)) &&
    (settings.msgSaveDeltime === null || validRetention(settings.msgSaveDeltime) || (scoped.value && settings.msgSaveDeltime === "invalid"));
}

async function request(method: "GET" | "PUT") {
  if (active) return;
  const current = baseline.value;
  if (method === "PUT" && (!current?.writable || !dirty.value || !canSaveRetention.value || conflict.value || confirmReload.value || confirmScope.value)) return;
  const body = method === "PUT" && current ? JSON.stringify({ revision: current.revision, patch: patch.value }) : undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  active = controller;
  busy.value = method;
  error.value = "";
  notice.value = "";
  confirmReload.value = false;
  try {
    const headers = new Headers();
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await panelFetch(`${endpoint}?${new URLSearchParams({ scope: selectedScope.value })}`, props.auth, {
      method, headers, body, signal: controller.signal,
    });
    if (active !== controller) return;
    if (response.status === 401) {
      emit("unauthorized");
      return;
    }
    if (response.status === 409) {
      conflict.value = true;
      error.value = "配置已被其他操作修改。请重新载入后再修改。";
      return;
    }
    if (!response.ok) {
      if (response.status === 403) {
        if (current) baseline.value = { ...current, writable: false };
        error.value = method === "PUT" ? "当前没有保存群通知配置的权限。" : "当前没有读取群通知配置的权限。";
      } else if (response.status === 404) error.value = "群通知配置不可用。";
      else if (response.status === 400) error.value = "群通知配置无效，请重新载入。";
      else error.value = method === "PUT" ? "宿主暂时无法保存群通知配置。" : "宿主暂时无法读取群通知配置。";
      return;
    }

    const data: unknown = await response.json().catch(() => undefined);
    if (active !== controller) return;
    if (!isSnapshot(data)) {
      error.value = "宿主返回了无法识别的群通知配置。";
      return;
    }
    baseline.value = data;
    draft.value = { ...data.settings };
    conflict.value = false;
    if (method === "PUT") notice.value = "群通知配置已保存。";
  } catch {
    if (active === controller) error.value = "暂时无法连接宿主，请重试。";
  } finally {
    clearTimeout(timeout);
    if (active === controller) {
      active = undefined;
      busy.value = undefined;
    }
  }
}

function reload() {
  if (dirty.value) confirmReload.value = true;
  else void request("GET");
}

function scopeLabel(scope: string) {
  if (scope === "default") return "全局默认";
  if (!scope.startsWith("bot:")) return `群 ${scope}`;
  const [, bot, group] = scope.split(":");
  return group ? `机器人 ${bot} 在群 ${group}` : `机器人 ${bot}`;
}

function loadScope(next: string) {
  confirmScope.value = undefined;
  selectedScope.value = inputScope.value = next;
  baseline.value = undefined;
  draft.value = undefined;
  conflict.value = false;
  void request("GET");
}

function selectScope() {
  if (!validScope.value || inputScope.value === selectedScope.value || busy.value) return;
  if (dirty.value) confirmScope.value = inputScope.value;
  else loadScope(inputScope.value);
}

function setOverride(key: (typeof fields)[number]["key"], event: Event) {
  if (!draft.value) return;
  const value = (event.currentTarget as HTMLSelectElement).value;
  draft.value[key] = value === "inherit" ? null : value === "on";
}

function setRetention(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  if (draft.value) draft.value.msgSaveDeltime = Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : null;
}

watch(() => props.auth, () => {
  active?.abort();
  active = undefined;
  busy.value = undefined;
  error.value = "";
  notice.value = "";
  baseline.value = undefined;
  draft.value = undefined;
  conflict.value = false;
  confirmReload.value = false;
  confirmScope.value = undefined;
  selectedScope.value = inputScope.value = "default";
  void request("GET");
}, { immediate: true });

onBeforeUnmount(() => {
  active?.abort();
  active = undefined;
  emit("dirty-change", false);
});
</script>

<template>
  <section class="group-settings" aria-labelledby="group-notice-settings-title" :aria-busy="Boolean(busy)">
    <div class="section-heading">
      <h1 id="group-notice-settings-title" tabindex="-1">群通知</h1>
      <ElButton :loading="busy === 'GET'" :disabled="Boolean(busy) || confirmReload" @click="reload">重新载入</ElButton>
    </div>

    <form class="settings-card" @submit.prevent="selectScope">
      <label class="notice-option" for="group-notice-target">配置范围</label>
      <div class="action-group">
        <input id="group-notice-target" v-model.trim="inputScope" list="group-notice-scopes" :disabled="Boolean(busy) || Boolean(confirmScope)" />
        <datalist id="group-notice-scopes">
          <option value="default">全局默认</option>
          <option v-for="scope in baseline?.scopes" :key="scope" :value="scope">{{ scopeLabel(scope) }}</option>
        </datalist>
        <ElButton native-type="submit" :disabled="!validScope || inputScope === selectedScope || Boolean(busy) || Boolean(confirmScope)">查看范围</ElButton>
      </div>
      <p class="subtitle">可选已有范围，也可输入群号、bot:机器人QQ 或 bot:机器人QQ:群号。填写 default 返回全局默认。</p>
    </form>
    <div v-if="confirmScope" class="feedback">
      <p>切换范围会放弃未保存的改动。</p>
      <div class="action-group">
        <ElButton @click="confirmScope = undefined">取消</ElButton>
        <ElButton type="danger" @click="loadScope(confirmScope!)">放弃改动并切换</ElButton>
      </div>
    </div>

    <div v-if="confirmReload" class="feedback">
      <p>重新载入会放弃未保存的改动。</p>
      <div class="action-group">
        <ElButton @click="confirmReload = false">取消</ElButton>
        <ElButton type="danger" @click="request('GET')">放弃改动并重载</ElButton>
      </div>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <p v-else-if="!draft && busy" class="placeholder" role="status">正在读取配置…</p>
    <p v-if="readOnly && !error" class="placeholder" role="status">当前配置只读。</p>

    <form v-if="draft" @submit.prevent="request('PUT')">
      <fieldset class="settings-card" aria-labelledby="group-notice-defaults" aria-describedby="group-notice-scope"
        :disabled="Boolean(busy) || readOnly || confirmReload || Boolean(confirmScope)">
        <h2 id="group-notice-defaults">{{ scopeLabel(selectedScope) }}</h2>
        <p id="group-notice-scope" class="subtitle">配置按全局、群、机器人、机器人在群中的顺序覆盖。选择继承可撤销当前范围的设置。</p>
        <label v-for="{ key, label } in fields" :key="key" class="notice-option">
          <span>{{ label }}
            <small v-if="key === 'notificationsAll' && draft.notificationsAll !== null" class="option-hint">{{ draft.notificationsAll ? "当前机器人的所有主人" : "当前机器人的首位主人" }}</small>
          </span>
          <select v-if="scoped" :id="`group-notice-${key}`" :value="draft[key] === null ? 'inherit' : draft[key] ? 'on' : 'off'"
            @change="setOverride(key, $event)">
            <option value="inherit">继承</option>
            <option value="on">{{ key === 'notificationsAll' ? '所有主人' : '开启' }}</option>
            <option value="off">{{ key === 'notificationsAll' ? '首位主人' : '关闭' }}</option>
          </select>
          <input v-else :id="`group-notice-${key}`" v-model="draft[key]" type="checkbox" />
        </label>
        <label class="notice-option" for="group-notice-msgSaveDeltime">
          <span>撤回消息缓存（秒）
            <small v-if="!scoped && baseline?.settings.msgSaveDeltime === null || draft.msgSaveDeltime === 'invalid'" class="option-hint">旧配置的缓存时长无效，可填入正整数修正。</small>
            <small v-else-if="scoped" class="option-hint">留空时继承其他范围的值。</small>
          </span>
          <input id="group-notice-msgSaveDeltime" class="retention-input" type="number" min="1" :max="maxRetention" step="1"
            :value="typeof draft.msgSaveDeltime === 'number' ? draft.msgSaveDeltime : ''" :aria-invalid="!canSaveRetention" @input="setRetention" />
          <ElButton v-if="scoped && draft.msgSaveDeltime !== null" @click="draft.msgSaveDeltime = null">继承</ElButton>
        </label>
        <p v-if="!canSaveRetention" class="error" role="alert">撤回缓存时长须填写有效的正整数秒数。</p>
      </fieldset>
      <div class="feedback save-bar">
        <p v-if="notice || dirty" role="status">{{ dirty ? "有未保存的改动" : notice }}</p>
        <ElButton type="primary" native-type="submit" :loading="busy === 'PUT'"
          :disabled="!dirty || !canSaveRetention || readOnly || conflict || Boolean(busy) || confirmReload || Boolean(confirmScope)">保存配置</ElButton>
      </div>
    </form>
    <GroupCleanupSettings :auth="auth" @unauthorized="emit('unauthorized')" @dirty-change="cleanupDirty = $event" />
  </section>
</template>

<style scoped>
.placeholder { color: var(--muted); font-size: 14px; line-height: 1.55; }
.subtitle { margin-bottom: 12px; }

.notice-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 44px;
  padding: 10px 0;
  border-top: 1px solid var(--line);
  font-size: 15px;
  font-weight: 600;
}

.notice-option:last-child { padding-bottom: 0; }
.notice-option input[type="checkbox"] { flex: 0 0 18px; width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
.option-hint { display: block; margin-top: 3px; color: var(--muted); font-weight: 400; }
.retention-input { width: min(125px, 35%); }
.notice-option input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
