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
type Settings = Record<(typeof fields)[number]["key"], boolean> & { msgSaveDeltime: number | null };
interface Snapshot {
  settings: Settings;
  revision: string;
  writable: boolean;
}

const endpoint = `${import.meta.env.BASE_URL}api/settings/group/notices`;
const baseline = shallowRef<Snapshot>();
const draft = ref<Settings>();
const busy = ref<"GET" | "PUT">();
const error = ref("");
const notice = ref("");
const conflict = ref(false);
const confirmReload = ref(false);
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
  draft.value?.msgSaveDeltime === baseline.value?.settings.msgSaveDeltime || validRetention(draft.value?.msgSaveDeltime));
const cleanupDirty = ref(false);
const readOnly = computed(() => baseline.value?.writable === false);
watch(dirty, (value) => {
  if (!value) confirmReload.value = false;
});
watch(() => dirty.value || cleanupDirty.value, value => emit("dirty-change", value));

function isSnapshot(value: unknown): value is Snapshot {
  if (value === null || typeof value !== "object" || !("revision" in value) ||
      typeof value.revision !== "string" || !("writable" in value) || typeof value.writable !== "boolean" ||
      !("settings" in value) || value.settings === null || typeof value.settings !== "object") return false;

  const settings = value.settings as Record<string, unknown>;
  return fields.every(({ key }) => typeof settings[key] === "boolean") &&
    (settings.msgSaveDeltime === null || validRetention(settings.msgSaveDeltime));
}

async function request(method: "GET" | "PUT") {
  if (active) return;
  const current = baseline.value;
  if (method === "PUT" && (!current?.writable || !dirty.value || !canSaveRetention.value || conflict.value || confirmReload.value)) return;
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
    const response = await panelFetch(endpoint, props.auth, {
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
        :disabled="Boolean(busy) || readOnly || confirmReload">
        <h2 id="group-notice-defaults">全局默认</h2>
        <p id="group-notice-scope" class="subtitle">群或机器人有单独配置时，以单独配置为准。</p>
        <label v-for="{ key, label } in fields" :key="key" class="notice-option">
          <span>{{ label }}
            <small v-if="key === 'notificationsAll'" class="option-hint">{{ draft.notificationsAll ? "当前机器人的所有主人" : "当前机器人的首位主人" }}</small>
          </span>
          <input :id="`group-notice-${key}`" v-model="draft[key]" type="checkbox" />
        </label>
        <label class="notice-option" for="group-notice-msgSaveDeltime">
          <span>撤回消息缓存（秒）
            <small v-if="baseline?.settings.msgSaveDeltime === null" class="option-hint">旧配置的缓存时长无效，可填入正整数修正。</small>
          </span>
          <input id="group-notice-msgSaveDeltime" class="retention-input" type="number" min="1" :max="maxRetention" step="1"
            :value="draft.msgSaveDeltime ?? ''" :aria-invalid="!canSaveRetention" @input="setRetention" />
        </label>
        <p v-if="!canSaveRetention" class="error" role="alert">撤回缓存时长须填写有效的正整数秒数。</p>
      </fieldset>
      <div class="feedback save-bar">
        <p v-if="notice || dirty" role="status">{{ dirty ? "有未保存的改动" : notice }}</p>
        <ElButton type="primary" native-type="submit" :loading="busy === 'PUT'"
          :disabled="!dirty || !canSaveRetention || readOnly || conflict || Boolean(busy) || confirmReload">保存配置</ElButton>
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
