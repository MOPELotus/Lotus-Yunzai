<script setup lang="ts">
import { ElButton, ElInput } from "element-plus";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";

const props = defineProps<{ token: string }>();
const emit = defineEmits<{
  unauthorized: [];
  "dirty-change": [dirty: boolean];
}>();

const toggles = [
  { key: "enable", label: "启用资料卡点赞", help: "处理群聊和私聊中的点赞指令。" },
  { key: "cloneAllThumbUp", label: "关闭 #全部赞我", help: "勾选后，#赞我 等其他指令仍按点赞总开关处理。" },
  { key: "strangeThumbUp", label: "允许向非好友点赞", help: "关闭后，仅处理协议端确认的好友。" },
] as const;
const messages = [
  { key: "closeTips", label: "功能关闭提示" },
  { key: "successMsg", label: "点赞成功提示" },
  { key: "failsMsg", label: "点赞失败提示" },
  { key: "noFriendMsg", label: "非好友提示" },
] as const;
type ToggleKey = (typeof toggles)[number]["key"];
type MessageKey = (typeof messages)[number]["key"];
type Settings = Record<ToggleKey, boolean> & Record<MessageKey, string | false> & { count: number; recall: number };
type Draft = Omit<Settings, "count" | "recall"> & { count: number | ""; recall: number | "" };
interface Snapshot {
  settings: Settings;
  revision: string;
}
const placeholderHelp = "{{at}} 提及发送者，{{userId}} 显示「你」，{{doType}} 显示操作名称，{{thumbUpNum}} 显示确认的点赞数。";
const keys = [...toggles.map(({ key }) => key), "count", "recall", ...messages.map(({ key }) => key)] as const;
const endpoint = `${import.meta.env.BASE_URL}api/settings/group/likes`;

const baseline = shallowRef<Snapshot>();
const draft = ref<Draft>();
const busy = ref<"GET" | "PUT">();
const error = ref("");
const notice = ref("");
const conflict = ref(false);
const confirmReload = ref(false);
const hiddenMessages = new Map<MessageKey, string>();
let active: AbortController | undefined;

const changed = computed(() => {
  const saved = baseline.value?.settings;
  const edited = draft.value;
  return saved && edited ? keys.filter((key) => saved[key] !== edited[key]) : [];
});
const dirty = computed(() => changed.value.length > 0);
const validCount = computed(() => isCount(draft.value?.count));
const validRecall = computed(() => isRecall(draft.value?.recall));
watch(dirty, (value) => {
  emit("dirty-change", value);
  if (!value) confirmReload.value = false;
});

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10;
}

function isRecall(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 120;
}

function isSnapshot(value: unknown): value is Snapshot {
  if (value === null || typeof value !== "object" || !("revision" in value) ||
      typeof value.revision !== "string" || !("settings" in value) ||
      value.settings === null || typeof value.settings !== "object") return false;

  const config = value.settings as Record<string, unknown>;
  return isCount(config.count) && isRecall(config.recall) &&
    toggles.every(({ key }) => typeof config[key] === "boolean") &&
    messages.every(({ key }) => config[key] === false || typeof config[key] === "string");
}

function setMessageEnabled(key: MessageKey, enabled: boolean) {
  const edited = draft.value;
  if (!edited) return;
  const before = edited[key];
  if (enabled) edited[key] = hiddenMessages.get(key) ?? "";
  else if (before !== false) {
    hiddenMessages.set(key, before);
    edited[key] = false;
  }
}

async function request(method: "GET" | "PUT") {
  if (active || !props.token) return;
  const current = baseline.value;
  const edited = draft.value;
  if (method === "PUT" && (!current || !edited || !dirty.value || !validCount.value || !validRecall.value || conflict.value)) return;
  const body = method === "PUT" && current && edited
    ? JSON.stringify({ revision: current.revision, patch: Object.fromEntries(changed.value.map((key) => [key, edited[key]])) })
    : undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  active = controller;
  busy.value = method;
  error.value = "";
  notice.value = "";
  confirmReload.value = false;
  try {
    const headers = new Headers({ Authorization: `Bearer ${props.token}` });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(endpoint, {
      method, headers, body, signal: controller.signal, cache: "no-store", redirect: "error", credentials: "omit",
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
      if (response.status === 400) error.value = "配置值无效，请检查点赞次数、撤回时间和提示文本。";
      else if (response.status === 404) error.value = "群点赞模块未启用。";
      else error.value = "宿主暂时无法读取或写入群点赞配置。";
      return;
    }

    const data: unknown = await response.json().catch(() => undefined);
    if (active !== controller) return;
    if (!isSnapshot(data)) {
      error.value = "宿主返回了无法识别的群点赞配置。";
      return;
    }
    baseline.value = data;
    draft.value = { ...data.settings };
    hiddenMessages.clear();
    conflict.value = false;
    if (method === "PUT") notice.value = "群点赞配置已保存。";
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

watch(() => props.token, () => {
  active?.abort();
  active = undefined;
  busy.value = undefined;
  error.value = "";
  notice.value = "";
  baseline.value = undefined;
  draft.value = undefined;
  conflict.value = false;
  confirmReload.value = false;
  hiddenMessages.clear();
  void request("GET");
}, { immediate: true });

onBeforeUnmount(() => {
  active?.abort();
  active = undefined;
  emit("dirty-change", false);
});
</script>

<template>
  <section class="like-settings" aria-labelledby="like-settings-title" :aria-busy="Boolean(busy)">
    <div class="section-heading">
      <h1 id="like-settings-title" tabindex="-1">群点赞配置</h1>
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

    <form v-if="draft" novalidate @submit.prevent="request('PUT')">
      <fieldset class="settings-card" aria-labelledby="like-rules-title" :disabled="Boolean(busy)">
        <div class="card-heading"><h2 id="like-rules-title">点赞规则</h2></div>
        <div v-for="toggle in toggles" :key="toggle.key" class="setting-row">
          <label :for="`like-${toggle.key}`">{{ toggle.label }}</label>
          <p class="setting-help" :id="`like-${toggle.key}-help`">{{ toggle.help }}</p>
          <input :id="`like-${toggle.key}`" v-model="draft[toggle.key]" type="checkbox" :aria-describedby="`like-${toggle.key}-help`" />
        </div>
        <div class="setting-row">
          <label for="like-count">每次点赞次数</label>
          <p class="setting-help" id="like-count-help">请输入 1 到 10 的整数。</p>
          <input id="like-count" v-model.number="draft.count" type="number" min="1" max="10" step="1"
            required aria-describedby="like-count-help" :aria-invalid="!validCount" />
        </div>
        <div class="setting-row">
          <label for="like-recall">结果回复撤回时间</label>
          <p class="setting-help" id="like-recall-help">单位为秒，填 0 保留回复，最长 120 秒。</p>
          <input id="like-recall" v-model.number="draft.recall" type="number" min="0" max="120" step="any"
            required aria-describedby="like-recall-help" :aria-invalid="!validRecall" />
        </div>
      </fieldset>

      <fieldset class="settings-card" aria-labelledby="like-messages-title" :disabled="Boolean(busy)">
        <div class="card-heading">
          <h2 id="like-messages-title">回复提示</h2>
          <p class="setting-help" v-text="placeholderHelp"></p>
        </div>
        <div class="message-grid">
          <div v-for="field in messages" :key="field.key" class="message-field">
            <div class="message-heading">
              <label :for="`like-${field.key}`">{{ field.label }}</label>
              <label class="message-toggle">
                <input
                  type="checkbox"
                  :aria-label="`发送${field.label}`"
                  :checked="draft[field.key] !== false"
                  @change="setMessageEnabled(field.key, ($event.target as HTMLInputElement).checked)"
                />
                <span>发送</span>
              </label>
            </div>
            <ElInput
              :id="`like-${field.key}`"
              type="textarea"
              :rows="2"
              :model-value="draft[field.key] || ''"
              :disabled="Boolean(busy) || draft[field.key] === false"
              placeholder="留空时不发送"
              @update:model-value="draft[field.key] = $event"
            />
          </div>
        </div>
      </fieldset>

      <div class="feedback save-bar">
        <p v-if="notice || dirty" role="status">{{ dirty ? "有未保存的改动" : notice }}</p>
        <ElButton type="primary" native-type="submit"
          :loading="busy === 'PUT'" :disabled="!dirty || !validCount || !validRecall || conflict || Boolean(busy)">
          保存配置
        </ElButton>
      </div>
    </form>
  </section>
</template>

<style scoped>
.like-settings form, .placeholder { margin-top: 20px; }

.settings-card {
  min-width: 0;
  margin: 0 0 16px;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: 15px;
  background: var(--surface);
}

.card-heading { padding-bottom: 12px; }
.card-heading .setting-help { margin-top: 6px; }
.setting-help, .placeholder { color: var(--muted); font-size: 14px; line-height: 1.55; }

.setting-row {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas: "label control" "help control";
  align-items: center;
  gap: 4px 14px;
  padding: 12px 0;
  border-top: 1px solid var(--line);
}

.setting-row:last-child { padding-bottom: 0; }
.setting-row > label { grid-area: label; }
.setting-row > p { grid-area: help; }
.setting-row > input { grid-area: control; justify-self: end; }

.setting-row label, .message-heading > label:first-child { font-size: 15px; font-weight: 600; }
input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--accent); }
input[type="number"] {
  width: 88px;
  min-height: 36px;
  padding: 4px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 5px;
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  font-size: 14px;
}
input[aria-invalid="true"] { border-color: #a23b30; }
input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.message-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 20px; }
.message-heading, .feedback { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.message-heading { margin-bottom: 6px; }
.message-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 30px;
  color: var(--muted);
  font-size: 13px;
}

.feedback {
  flex-wrap: wrap;
  margin-top: 14px;
  color: var(--muted);
  font-size: 14px;
}

.save-bar > .el-button { margin-inline-start: auto; }
.action-group { display: flex; flex-wrap: wrap; gap: 8px; }
.action-group > .el-button { margin: 0; }

@media (max-width: 600px) {
  .settings-card { padding: 14px; }
  .message-grid { grid-template-columns: 1fr; }
}
</style>
