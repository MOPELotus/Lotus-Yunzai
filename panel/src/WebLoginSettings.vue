<script setup lang="ts">
import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { WebLoginSettings, WebLoginSnapshot } from "../../lib/panel-web-login-schema.ts";
import { panelFetch, type PanelAuth } from "./api.ts";

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const endpoint = `${import.meta.env.BASE_URL}api/settings/web/login`;
const userDurations = [
  { key: "ticket_minutes", label: "登录链接有效期（分钟）", step: "1" },
  { key: "session_hours", label: "登录会话有效期（小时）", step: "any" },
] as const;
const panelDurations = [
  { key: "panel_ticket_minutes", label: "管理链接有效期（分钟）", step: "1" },
  { key: "panel_session_hours", label: "管理会话有效期（小时）", step: "any" },
] as const;
const durations = [...userDurations, ...panelDurations];
type Draft = Omit<WebLoginSettings, typeof durations[number]["key"]> & Record<typeof durations[number]["key"], string>;

const saved = shallowRef<WebLoginSnapshot>();
const draft = ref<Draft>();
const busy = ref<"GET" | "PUT">();
const error = ref("");
const notice = ref("");
const conflict = ref(false);
const confirmReload = ref(false);
let active: AbortController | undefined;

function asDraft(settings: WebLoginSettings): Draft {
  return {
    ...settings,
    ticket_minutes: String(settings.ticket_minutes), session_hours: String(settings.session_hours),
    panel_ticket_minutes: String(settings.panel_ticket_minutes), panel_session_hours: String(settings.panel_session_hours),
  };
}

const changed = computed(() => {
  if (!draft.value || !saved.value) return {};
  const before = saved.value.settings;
  const values: WebLoginSettings = {
    ...draft.value,
    ticket_minutes: Number(draft.value.ticket_minutes), session_hours: Number(draft.value.session_hours),
    panel_ticket_minutes: Number(draft.value.panel_ticket_minutes), panel_session_hours: Number(draft.value.panel_session_hours),
  };
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => before[key as keyof WebLoginSettings] !== value));
});
const dirty = computed(() => Object.keys(changed.value).length > 0);
watch(dirty, value => { emit("dirty-change", value); if (!value) confirmReload.value = false; });

function isSnapshot(input: unknown): input is WebLoginSnapshot {
  if (!input || typeof input !== "object" || !("revision" in input) || !("settings" in input) ||
      typeof input.revision !== "string" || !/^[a-f0-9]{64}$/u.test(input.revision) ||
      !input.settings || typeof input.settings !== "object") return false;
  const item = input.settings as Partial<WebLoginSettings>;
  return typeof item.enable === "boolean" && typeof item.public_url === "string" && typeof item.path === "string" &&
    durations.every(({ key }) => typeof item[key] === "number" && Number.isFinite(item[key]));
}

async function request(method: "GET" | "PUT") {
  if (active || (method === "PUT" && (!saved.value || !dirty.value || conflict.value || confirmReload.value))) return;
  const controller = new AbortController();
  active = controller;
  busy.value = method;
  error.value = "";
  notice.value = "";
  confirmReload.value = false;
  try {
    const body = method === "PUT" ? JSON.stringify({ revision: saved.value!.revision, patch: changed.value }) : undefined;
    const response = await panelFetch(endpoint, props.auth, {
      method, body, headers: body ? { "Content-Type": "application/json" } : undefined,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    if (active !== controller) return;
    if (response.status === 401) return emit("unauthorized");
    if (response.status === 409) {
      conflict.value = true;
      error.value = "网页登录设置已在别处修改。请重新读取后再保存。";
      return;
    }
    if (response.status === 400 || response.status === 422) {
      error.value = response.status === 400 ? "请检查访问地址、挂载路径和有效期。" : "用户网页路径与已配置的 Milky Webhook 冲突。";
      return;
    }
    if (!response.ok) throw new Error();
    const snapshot = await response.json() as unknown;
    if (active !== controller) return;
    if (!isSnapshot(snapshot)) throw new Error();
    saved.value = snapshot;
    draft.value = asDraft(snapshot.settings);
    conflict.value = false;
    if (method === "PUT") notice.value = "已保存。";
  } catch {
    if (active === controller) error.value = "暂时无法读取或保存网页登录设置。";
  } finally {
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

onMounted(() => { void request("GET"); });
onBeforeUnmount(() => {
  active?.abort();
  active = undefined;
  emit("dirty-change", false);
});
</script>

<template>
  <section aria-labelledby="web-login-title" :aria-busy="Boolean(busy)">
    <div class="section-heading">
      <h1 id="web-login-title" tabindex="-1">网页登录</h1>
      <ElButton :loading="busy === 'GET'" :disabled="Boolean(busy) || confirmReload" @click="reload">重新读取</ElButton>
    </div>
    <div v-if="confirmReload" class="login-settings-actions" role="alert">
      <span>重新读取会放弃未保存的改动。</span>
      <ElButton @click="confirmReload = false">继续编辑</ElButton>
      <ElButton type="danger" @click="request('GET')">放弃改动并读取</ElButton>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <form v-if="draft" class="login-settings" @submit.prevent="request('PUT')">
      <fieldset :disabled="Boolean(busy) || confirmReload">
        <legend>米游社用户网页</legend>
        <label class="login-toggle">
          <input v-model="draft.enable" type="checkbox" />启用用户网页
        </label>
        <label>
          公网访问地址
          <input v-model="draft.public_url" type="text" inputmode="url" placeholder="留空使用宿主地址" maxlength="2048" />
        </label>
        <label>
          用户网页挂载路径
          <input v-model="draft.path" type="text" placeholder="留空按访问地址或默认路径" maxlength="512" />
        </label>
        <label v-for="field in userDurations" :key="field.key">
          {{ field.label }}
          <input v-model="draft[field.key]" type="number" :step="field.step" :min="field.step === '1' ? 1 : 0" required />
        </label>
      </fieldset>
      <fieldset :disabled="Boolean(busy) || confirmReload">
        <legend>管理面板</legend>
        <label v-for="field in panelDurations" :key="field.key">
          {{ field.label }}
          <input v-model="draft[field.key]" type="number" :step="field.step" :min="field.step === '1' ? 1 : 0" required />
        </label>
      </fieldset>
      <p class="login-note">新链接和新登录立即使用保存的有效期。用户网页的启用状态、地址和路径在重启宿主后生效。</p>
      <div class="login-settings-actions">
        <ElButton type="primary" native-type="submit" :loading="busy === 'PUT'"
          :disabled="!dirty || Boolean(busy) || confirmReload || conflict">保存</ElButton>
        <span v-if="notice" role="status">{{ notice }}</span>
      </div>
    </form>
  </section>
</template>

<style scoped>
.login-settings { display: grid; gap: 12px; max-width: 660px; margin-top: 20px; }
.login-settings fieldset {
  display: grid; gap: 10px; min-width: 0; margin: 0; padding: 14px;
  border: 1px solid var(--line); border-radius: 12px; background: var(--surface);
}
.login-settings legend { padding: 0 4px; font-weight: 650; }
.login-settings label { display: grid; gap: 4px; font-size: 14px; font-weight: 600; }
.login-settings label.login-toggle { display: flex; align-items: center; }
.login-toggle input { accent-color: var(--accent); }
.login-settings input:not([type="checkbox"]) {
  width: 100%; min-height: 36px; padding: 0 9px; border: 1px solid var(--el-border-color);
  border-radius: 4px; background: var(--surface); color: inherit; font: inherit; font-weight: 400;
}
.login-note, .login-settings-actions span { color: var(--muted); font-size: 14px; }
.login-settings-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.login-settings-actions :deep(.el-button + .el-button) { margin-left: 0; }
</style>
