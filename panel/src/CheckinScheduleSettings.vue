<script setup lang="ts">
import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { scheduleCronFields, type CheckinSchedulePanelSettings, type CheckinSchedulePanelSnapshot } from "../../lib/panel-checkin-schedule-schema.ts";
import { panelFetch, type PanelAuth } from "./api.ts";

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const endpoint = `${import.meta.env.BASE_URL}api/settings/checkin/schedule`;
const cronLabels = {
  plan_generate_cron: "次日计划生成",
  run_due_cron: "到期任务扫描",
  catch_up_cron: "缺失计划补偿检查",
} as const;

const saved = shallowRef<CheckinSchedulePanelSnapshot>();
const draft = ref<CheckinSchedulePanelSettings>();
const busy = ref<"GET" | "PUT">();
const error = ref("");
const notice = ref("");
const conflict = ref(false);
const confirmReload = ref(false);
let active: AbortController | undefined;

function differences(next: Record<string, unknown>, before: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => before[key] !== value));
}

const changed = computed(() => {
  if (!draft.value || !saved.value) return {};
  const { random, late_registration, ...fields } = draft.value;
  const before = saved.value.settings;
  const randomChanges = differences(random, before.random);
  const lateChanges = differences(late_registration, before.late_registration);
  return {
    ...differences(fields, before),
    ...(Object.keys(randomChanges).length && { random: randomChanges }),
    ...(Object.keys(lateChanges).length && { late_registration: lateChanges }),
  };
});
const dirty = computed(() => Object.keys(changed.value).length > 0);
watch(dirty, value => {
  emit("dirty-change", value);
  if (!value) confirmReload.value = false;
});

function isSnapshot(input: unknown): input is CheckinSchedulePanelSnapshot {
  if (!input || typeof input !== "object" || !("revision" in input) || !("settings" in input) || !("invalidCrons" in input) ||
      typeof input.revision !== "string" || !/^[a-f0-9]{64}$/u.test(input.revision) ||
      !input.settings || typeof input.settings !== "object" || !Array.isArray(input.invalidCrons) ||
      !input.invalidCrons.every(key => scheduleCronFields.includes(key))) return false;
  const item = input.settings as Partial<CheckinSchedulePanelSettings>;
  return typeof item.enable === "boolean" && (item.mode === "fixed" || item.mode === "random") &&
    typeof item.fixed_time === "string" && scheduleCronFields.every(key => typeof item[key] === "string") &&
    typeof item.random?.window_start === "string" && typeof item.random?.window_end === "string" &&
    typeof item.random?.notify_before === "boolean" && typeof item.late_registration?.window_start === "string" &&
    typeof item.late_registration?.window_end === "string" && typeof item.late_registration?.enable === "boolean" &&
    typeof item.late_registration?.notify === "boolean";
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
      error.value = "签到调度设置已在别处修改。请重新读取后再保存。";
      return;
    }
    if (response.status === 400) {
      error.value = "请检查时间及 Cron 表达式。";
      return;
    }
    if (response.status === 422) {
      error.value = "窗口结束时间不能早于开始时间。";
      return;
    }
    if (!response.ok) throw new Error();
    const result: unknown = await response.json();
    if (active !== controller) return;
    if (!isSnapshot(result)) throw new Error();
    saved.value = result;
    draft.value = structuredClone(result.settings);
    conflict.value = false;
    if (method === "PUT") notice.value = "已保存，重启宿主后生效。";
  } catch {
    if (active === controller) error.value = "暂时无法读取或保存签到调度设置。";
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
  <section aria-labelledby="checkin-schedule-title" :aria-busy="Boolean(busy)">
    <div class="section-heading">
      <h1 id="checkin-schedule-title" tabindex="-1">签到调度</h1>
      <ElButton :loading="busy === 'GET'" :disabled="Boolean(busy) || confirmReload" @click="reload">重新读取</ElButton>
    </div>
    <div v-if="confirmReload" class="schedule-actions" role="alert">
      <span>重新读取会放弃未保存的改动。</span>
      <ElButton @click="confirmReload = false">继续编辑</ElButton>
      <ElButton type="danger" @click="request('GET')">放弃改动并读取</ElButton>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <form v-if="draft" class="schedule-settings" @submit.prevent="request('PUT')">
      <fieldset :disabled="Boolean(busy) || confirmReload">
        <legend>全局默认</legend>
        <label class="schedule-toggle">
          <input v-model="draft.enable" type="checkbox" />
          启用自动调度
        </label>
        <label>
          默认签到模式
          <select v-model="draft.mode">
            <option value="fixed">固定时间</option>
            <option value="random">随机时间</option>
          </select>
        </label>
        <label>
          固定签到时间
          <input v-model="draft.fixed_time" type="time" required />
        </label>
      </fieldset>
      <fieldset :disabled="Boolean(busy) || confirmReload">
        <legend>随机签到</legend>
        <div class="schedule-window">
          <label>
            随机窗口开始
            <input v-model="draft.random.window_start" name="random_window_start" type="time" required />
          </label>
          <label>
            随机窗口结束
            <input v-model="draft.random.window_end" name="random_window_end" type="time" required />
          </label>
        </div>
        <label class="schedule-toggle">
          <input v-model="draft.random.notify_before" name="random_notify_before" type="checkbox" />
          生成次日计划后通知用户
        </label>
      </fieldset>
      <fieldset :disabled="Boolean(busy) || confirmReload">
        <legend>补注册</legend>
        <label class="schedule-toggle">
          <input v-model="draft.late_registration.enable" name="late_enable" type="checkbox" />
          允许补注册到已有计划
        </label>
        <div class="schedule-window">
          <label>
            补注册窗口开始
            <input v-model="draft.late_registration.window_start" name="late_window_start" type="time" required />
          </label>
          <label>
            补注册窗口结束
            <input v-model="draft.late_registration.window_end" name="late_window_end" type="time" required />
          </label>
        </div>
        <p>窗口用于分配补注册的随机签到时间。当天随机补注册在窗口结束后关闭，固定时间档案沿用原签到时间。</p>
        <label class="schedule-toggle">
          <input v-model="draft.late_registration.notify" name="late_notify" type="checkbox" />
          补注册后通知签到时间
        </label>
      </fieldset>
      <fieldset :disabled="Boolean(busy) || confirmReload">
        <legend>定时规则</legend>
        <label v-for="field in scheduleCronFields" :key="field">
          {{ cronLabels[field] }}
          <input v-model="draft[field]" :name="field" spellcheck="false" autocomplete="off" />
          <small v-if="saved?.invalidCrons.includes(field)">原规则无效，此处显示运行时使用的默认规则。</small>
        </label>
        <p>使用北京时间。留空恢复该项默认规则。</p>
      </fieldset>
      <p class="schedule-note">保存后重启宿主生效。保存不会立即改写签到计划。</p>
      <div class="schedule-actions">
        <ElButton type="primary" native-type="submit" :loading="busy === 'PUT'"
          :disabled="!dirty || Boolean(busy) || confirmReload || conflict">保存</ElButton>
        <span v-if="notice" role="status">{{ notice }}</span>
      </div>
    </form>
  </section>
</template>

<style scoped>
.schedule-settings { display: grid; gap: 12px; max-width: 660px; margin-top: 20px; }
.schedule-settings fieldset {
  display: grid; gap: 10px; min-width: 0; margin: 0; padding: 14px;
  border: 1px solid var(--line); border-radius: 12px; background: var(--surface);
}
.schedule-settings legend { padding: 0 4px; font-weight: 650; }
.schedule-settings label { display: grid; gap: 4px; font-size: 14px; font-weight: 600; }
.schedule-settings label.schedule-toggle { display: flex; align-items: center; }
.schedule-toggle input { accent-color: var(--accent); }
.schedule-window { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); }
.schedule-settings :is(input:not([type="checkbox"]), select) {
  width: 100%; min-height: 36px; padding: 0 9px; border: 1px solid var(--el-border-color);
  border-radius: 4px; background: var(--surface); color: inherit; font: inherit; font-weight: 400;
}
.schedule-settings :is(p, small), .schedule-actions span { margin: 0; color: var(--muted); font-size: 14px; font-weight: 400; }
.schedule-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.schedule-actions :deep(.el-button + .el-button) { margin-left: 0; }
</style>
