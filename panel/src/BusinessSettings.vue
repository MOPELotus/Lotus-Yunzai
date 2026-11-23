<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElButton } from "element-plus";
import { panelFetch, type PanelAuth } from "./api";
import GroupRoutingSettings from "./GroupRoutingSettings.vue";
import GroupWarpSettings from "./GroupWarpSettings.vue";

interface Field {
  key: string;
  label: string;
  type: "boolean" | "text" | "number" | "select" | "list" | "json";
  options?: readonly { label: string; value: string | number }[];
  min?: number;
  max?: number;
  hint?: string;
  readonly?: boolean;
  nullable?: boolean;
  rows?: number;
  itemType?: "number" | "string";
  separator?: "line";
  keepWhitespace?: boolean;
  multiline?: boolean;
}
type Values = Record<string, unknown>;
interface Snapshot { fields: Field[]; values: Values; defaults?: Values; warning?: string }

const props = defineProps<{ auth: PanelAuth; sections: readonly { key: string; label: string }[] }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const current = ref(props.sections[0]?.key ?? "");
const fields = ref<Field[]>([]);
const stored = ref<Values>({});
const defaults = ref<Values>();
const draft = ref<Record<string, string | boolean>>({});
const busy = ref(false);
const feedback = ref("");
const problem = ref("");
let active: AbortController | undefined;

const groupRules = computed<Record<string, unknown>>({
  get: () => draft.value.rules ? JSON.parse(String(draft.value.rules)) as Values : {},
  set: value => { draft.value.rules = JSON.stringify(value, null, 2); },
});
type WarpAllowance = Partial<Record<"special" | "regular" | "recallSeconds", string | number>>;
const warpGroups = computed<Record<string, WarpAllowance>>({
  get: () => draft.value.groups ? JSON.parse(String(draft.value.groups)) as Record<string, WarpAllowance> : {},
  set: value => { draft.value.groups = JSON.stringify(value, null, 2); },
});
const warpAllowance = computed<WarpAllowance>(() => ({
  special: String(draft.value.special ?? ""), regular: String(draft.value.regular ?? ""),
  recallSeconds: String(draft.value.recallSeconds ?? ""),
}));

function resetWarp(ratesOnly: boolean) {
  const rates = new Set(["characterFive", "characterFour", "coneFive", "coneFour", "featuredFive"]);
  if (!defaults.value) return;
  for (const field of fields.value) {
    if (field.key !== "groups" && (!ratesOnly || rates.has(field.key))) {
      draft.value[field.key] = formatted(field, defaults.value[field.key]);
    }
  }
}

function formatted(field: Field, value: unknown): string | boolean {
  if (field.type === "boolean") return value === true;
  if (field.type === "list") return Array.isArray(value) ? value.join("\n") : "";
  if (field.type === "json") return value == null ? "" : JSON.stringify(value, null, 2);
  return value == null ? "" : String(value);
}

function baseline() {
  return Object.fromEntries(fields.value.map(field => [field.key, formatted(field, stored.value[field.key])]));
}

function changeText(key: string, event: Event) {
  draft.value[key] = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
}

const dirty = computed(() => fields.value.some(field => draft.value[field.key] !== formatted(field, stored.value[field.key])));
watch(dirty, value => emit("dirty-change", value));

function decode(field: Field) {
  const before = stored.value[field.key];
  const value = draft.value[field.key];
  if (field.readonly || value === formatted(field, before)) return before;
  if (field.type === "boolean") return value === true;
  const text = String(value ?? "");
  if (field.type === "number") {
    if (field.nullable && !text.trim()) return null;
    const number = Number(text);
    if (!text.trim() || !Number.isFinite(number) || number < (field.min ?? -Infinity) || number > (field.max ?? Infinity)) {
      throw new Error(`${field.label}的数值无效。`);
    }
    return number;
  }
  if (field.type === "select") {
    const option = field.options?.find(item => String(item.value) === text);
    if (!option) throw new Error(`请选择${field.label}。`);
    return option.value;
  }
  if (field.type === "json") {
    try { return text.trim() ? JSON.parse(text) as unknown : null; }
    catch { throw new Error(`${field.label}的 JSON 格式有误。`); }
  }
  if (field.type === "list") {
    const items = text.split(field.separator === "line" ? /\r?\n/u : /[\n,，]+/u)
      .map(item => field.keepWhitespace ? item : item.trim()).filter(Boolean);
    return field.itemType === "number" ? items.map(item => {
      const number = Number(item);
      if (!Number.isSafeInteger(number)) throw new Error(`${field.label}须填写有效数字。`);
      return number;
    }) : items;
  }
  return text;
}

async function update(save = false) {
  if (!current.value) return;
  active?.abort();
  const controller = new AbortController();
  active = controller;
  feedback.value = problem.value = "";
  busy.value = true;
  try {
    const values = save ? Object.fromEntries(fields.value.map(field => [field.key, decode(field)])) : undefined;
    const response = await panelFetch(`${import.meta.env.BASE_URL}api/settings/native/${current.value}`, props.auth, {
      method: save ? "PUT" : "GET",
      headers: save ? { "Content-Type": "application/json" } : undefined,
      body: save ? JSON.stringify({ previous: stored.value, values }) : undefined,
      signal: controller.signal,
    });
    if (response.status === 401) { emit("unauthorized"); return; }
    if (response.status === 409) throw new Error("配置已被修改。请重新读取后保存。");
    if (response.status === 400 || response.status === 403 || response.status === 503) {
      const reply = await response.json().catch(() => undefined) as { message?: string } | undefined;
      if (typeof reply?.message === "string" && reply.message) throw new Error(reply.message);
      if (response.status === 400) throw new Error("请检查设置项的值。");
      if (response.status === 403) throw new Error("当前会话无权修改或读取此设置。");
    }
    if (!response.ok) throw new Error(save ? "暂时无法保存设置。" : "暂时无法读取设置。");
    const result = await response.json() as Snapshot;
    if (controller.signal.aborted) return;
    fields.value = result.fields;
    stored.value = result.values;
    defaults.value = result.defaults;
    draft.value = baseline();
    if (save) feedback.value = result.warning ?? "已保存";
  } catch (error) {
    if (!controller.signal.aborted) problem.value = error instanceof Error ? error.message : "设置请求失败。";
  } finally {
    if (active === controller) busy.value = false;
  }
}

watch(current, () => {
  fields.value = [];
  stored.value = {};
  defaults.value = undefined;
  draft.value = {};
  void update();
}, { immediate: true });
onBeforeUnmount(() => {
  active?.abort();
  emit("dirty-change", false);
});
</script>

<template>
  <section aria-labelledby="native-settings-title" :aria-busy="busy">
    <h1 id="native-settings-title" tabindex="-1">业务设置</h1>
    <nav class="panel-nav" aria-label="业务设置分类">
      <ElButton v-for="section in sections" :key="section.key" :disabled="dirty && current !== section.key"
        :type="current === section.key ? 'primary' : 'default'" :aria-current="current === section.key ? 'page' : undefined"
        @click="current = section.key">{{ section.label }}</ElButton>
    </nav>
    <form class="native-form" @submit.prevent="update(true)">
      <template v-for="field in fields" :key="field.key">
        <GroupRoutingSettings v-if="current === 'group-routing' && field.key === 'rules'"
          v-model="groupRules" :disabled="busy" :legacy="stored.file === 'config/config/group.yaml'" />
        <GroupWarpSettings v-else-if="current === 'starrail-warp' && field.key === 'groups'"
          v-model="warpGroups" :allowance="warpAllowance" :disabled="busy" />
        <div v-else class="native-field">
          <label :for="'native-' + field.key">{{ field.label }}</label>
          <input v-if="field.type === 'boolean'" :id="'native-' + field.key" v-model="draft[field.key]"
            :disabled="busy || field.readonly" type="checkbox">
          <select v-else-if="field.type === 'select'" :id="'native-' + field.key" v-model="draft[field.key]"
            :disabled="busy || field.readonly">
            <option v-for="option in field.options" :key="option.value" :value="String(option.value)">{{ option.label }}</option>
          </select>
          <textarea v-else-if="field.type === 'list' || field.type === 'json' || field.multiline" :id="'native-' + field.key"
            :value="String(draft[field.key] ?? '')" :rows="field.rows ?? 4" :disabled="busy || field.readonly"
            :placeholder="field.type === 'list' ? '每行一项' : undefined" @input="changeText(field.key, $event)" />
          <input v-else :id="'native-' + field.key" v-model="draft[field.key]" :disabled="busy || field.readonly"
            :inputmode="field.type === 'number' ? 'decimal' : undefined">
          <span v-if="field.hint" class="native-hint">{{ field.hint }}</span>
        </div>
      </template>
      <p v-if="problem" class="error" role="alert">{{ problem }}</p>
      <p v-if="feedback" role="status">{{ feedback }}</p>
      <div class="native-actions">
        <ElButton type="primary" native-type="submit" :disabled="!dirty || busy" :loading="busy && dirty">保存</ElButton>
        <ElButton :disabled="busy" @click="update()">重新读取</ElButton>
        <ElButton :disabled="!dirty || busy" @click="draft = baseline()">撤销编辑</ElButton>
        <template v-if="current === 'starrail-warp' && defaults">
          <ElButton :disabled="busy" @click="resetWarp(false)">恢复全局默认</ElButton>
          <ElButton :disabled="busy" @click="resetWarp(true)">恢复默认概率</ElButton>
        </template>
      </div>
    </form>
  </section>
</template>

<style scoped>
.native-form { display: grid; gap: 16px; margin-top: 20px; max-width: 760px; }
.native-field { display: grid; gap: 6px; }
.native-field input:not([type="checkbox"]), .native-field select, .native-field textarea {
  width: 100%;
  min-height: 34px;
  padding: 6px 9px;
  color: var(--el-text-color-primary);
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  font: inherit;
}
.native-field input[type="checkbox"] { width: 18px; height: 18px; margin: 0; }
.native-field textarea { resize: vertical; }
.native-hint { color: var(--el-text-color-secondary); font-size: .875rem; overflow-wrap: anywhere; }
.native-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.native-actions :deep(.el-button + .el-button) { margin-left: 0; }
</style>
