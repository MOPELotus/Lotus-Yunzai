<script setup lang="ts">
import { ElButton, ElInput } from "element-plus";
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from "vue";
import GuobaSubform from "./GuobaSubform.vue";
import type { GuobaEdit, GuobaField, GuobaInput, GuobaSubformEdit, GuobaSubformSnapshot } from "../../lib/panel-guoba.ts";

const props = defineProps<{ token: string }>();
const emit = defineEmits<{
  unauthorized: [];
  "dirty-change": [dirty: boolean];
}>();

interface Snapshot {
  schemas: GuobaField[];
  values: Record<string, GuobaInput>;
  configuredPasswords: string[];
  subforms?: Record<string, GuobaSubformSnapshot>;
  writable?: boolean;
}
type Operation = { kind: "list" } | { kind: "read"; plugin: string } | { kind: "save" };
type Scalar = Exclude<GuobaInput, unknown[]>;

const endpoint = `${import.meta.env.BASE_URL}api/guoba`;
const plugins = shallowRef<string[]>([]);
const selected = ref("");
const snapshot = shallowRef<Snapshot>();
const edits = reactive(new Map<string, GuobaEdit>());
const tagDrafts = reactive(new Map<string, string>());
const readOnly = ref(false);
const query = ref("");
const error = ref("");
const notice = ref("");
const pending = shallowRef<Exclude<Operation, { kind: "save" }>>();
const clearPending = ref<string>();
const busy = ref<Operation["kind"]>();
let active: AbortController | undefined;

const dirty = computed(() => edits.size > 0);
const rows = computed(() => {
  const needle = query.value.trim().toLowerCase();
  const allRows = (snapshot.value?.schemas ?? []).map((schema, index) => ({
    schema,
    field: schema.field,
    id: `plugin-field-${index}`,
  }));
  if (!needle) return allRows;

  const matches = (text: string | undefined) => text?.toLowerCase().includes(needle) === true;
  const visible: typeof allRows = [];
  let heading: (typeof allRows)[number] | undefined;
  let groupMatches = false;
  for (const row of allRows) {
    const { schema, field } = row;
    if (schema.component === "Divider") {
      heading = row;
      groupMatches = matches(schema.label);
      continue;
    }
    if (!groupMatches && ![schema.label, field, schema.bottomHelpMessage].some(matches)) continue;
    if (heading) {
      visible.push(heading);
      heading = undefined;
    }
    visible.push(row);
  }
  return visible;
});
watch(dirty, (value) => {
  emit("dirty-change", value);
  if (!value) pending.value = undefined;
});

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSchema(value: unknown): value is GuobaField {
  return isRecord(value) && typeof value.component === "string" && typeof value.label === "string" &&
    (value.component === "Divider" || typeof value.field === "string") &&
    (value.bottomHelpMessage === undefined || typeof value.bottomHelpMessage === "string");
}

async function request(path: string, signal: AbortSignal, body?: Record<string, GuobaEdit>): Promise<unknown> {
  const headers = new Headers({ Authorization: `Bearer ${props.token}` });
  if (body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    method: body ? "PUT" : "GET", headers, signal, body: body && JSON.stringify(body),
    credentials: "omit", cache: "no-store", redirect: "error",
  });
  if (!response.ok) {
    const messages: Record<number, string> = {
      404: "此插件没有可用的配置表单。",
      409: "子表单已在其他会话更改，请重新读取。",
      405: "此配置表单只读。",
      400: "配置值无效，或插件拒绝保存。",
      422: "插件拒绝保存，请检查配置值。",
    };
    throw new RequestError(response.status, messages[response.status] ?? "宿主暂时无法读取或写入插件配置。");
  }
  return response.json().catch(() => undefined);
}

async function read(plugin: string, signal: AbortSignal): Promise<Snapshot> {
  const data = await request(`${endpoint}/${encodeURIComponent(plugin)}`, signal);
  if (!isRecord(data) || !Array.isArray(data.schemas) || !data.schemas.every(isSchema) || !isRecord(data.values) ||
      !strArray(data.configuredPasswords)) {
    throw new RequestError(500, "宿主返回了无法识别的配置表单。");
  }
  return {
    schemas: data.schemas,
    values: data.values as Snapshot["values"],
    configuredPasswords: data.configuredPasswords,
    subforms: isRecord(data.subforms) ? data.subforms as Snapshot["subforms"] : undefined,
    writable: typeof data.writable === "boolean" ? data.writable : undefined,
  };
}

async function operate(operation: Operation) {
  if (active || !props.token) return;
  if (operation.kind === "save" && (!dirty.value || readOnly.value)) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 14_000);
  active = controller;
  busy.value = operation.kind;
  pending.value = undefined;
  clearPending.value = undefined;
  error.value = "";
  notice.value = "";
  let saved = false;
  let plugin = operation.kind === "read" ? operation.plugin : selected.value;
  try {
    if (operation.kind === "list") {
      const result = await request(endpoint, controller.signal);
      if (active !== controller) return;
      if (!isRecord(result) || !strArray(result.plugins)) {
        throw new RequestError(500, "宿主返回了无法识别的可配置插件清单。");
      }
      plugins.value = result.plugins;
      if (!result.plugins.includes(plugin)) {
        selected.value = "";
        snapshot.value = undefined;
        edits.clear();
        plugin = result.plugins[0] ?? "";
      }
    }
    if (!plugin) return;

    if (operation.kind === "save") {
      const patch = Object.fromEntries(edits);
      const result = await request(`${endpoint}/${encodeURIComponent(plugin)}`, controller.signal, patch);
      if (active !== controller) return;
      if (!isRecord(result) || result.ok !== true) {
        throw new RequestError(400, "插件未确认保存，请检查配置值。");
      }
      saved = true;
      edits.clear();
      notice.value = typeof result.message === "string" ? result.message : "配置已保存。";
    }

    const data = await read(plugin, controller.signal);
    if (active !== controller) return;
    if (selected.value !== plugin) query.value = "";
    selected.value = plugin;
    snapshot.value = data;
    readOnly.value = data.writable === false;
    edits.clear();
    tagDrafts.clear();
  } catch (failure) {
    if (active !== controller) return;
    if (failure instanceof RequestError && failure.status === 401) {
      emit("unauthorized");
      return;
    }
    if (failure instanceof RequestError && failure.status === 405 && operation.kind === "save" && !saved) {
      readOnly.value = true;
    }
    if (saved) {
      snapshot.value = undefined;
      error.value = "配置已保存，但暂时无法重新读取。请重新载入。";
    } else {
      error.value = failure instanceof RequestError ? failure.message : "暂时无法连接宿主，请重试。";
    }
  } finally {
    clearTimeout(timeout);
    if (active === controller) {
      active = undefined;
      busy.value = undefined;
    }
  }
}

function requestNavigation(operation: Exclude<Operation, { kind: "save" }>) {
  if (dirty.value) pending.value = operation;
  else void operate(operation);
}

function changePlugin(event: Event) {
  const control = event.target as HTMLSelectElement;
  const plugin = control.value;
  control.value = selected.value;
  if (plugin !== selected.value) requestNavigation({ kind: "read", plugin });
}

function fieldValue(field: string): GuobaInput | undefined {
  return edits.has(field) ? edits.get(field) as GuobaInput : savedValue(field);
}

function savedValue(field: string): GuobaInput | undefined {
  const values = snapshot.value?.values;
  return values && Object.hasOwn(values, field) ? values[field] : undefined;
}

function update(field: string, value: GuobaInput) {
  const before = savedValue(field);
  const same = Array.isArray(value) && Array.isArray(before)
    ? value.length === before.length && value.every((item, index) => item === before[index])
    : value === before;
  if (same) edits.delete(field);
  else edits.set(field, value);
}

function displayText(value: GuobaInput | undefined): string {
  if (value == null) return "";
  return Array.isArray(value) ? value.map(String).join("\n") : String(value);
}

function updateText(field: string, event: Event) {
  update(field, (event.target as HTMLInputElement).value);
}

function updateNumber(field: string, event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.validity.badInput) return;
  update(field, Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : null);
}

function updateSwitch(field: string, event: Event) {
  update(field, (event.target as HTMLInputElement).checked);
}

function changePassword(field: string, value: string) {
  if (value) edits.set(field, value);
  else edits.delete(field);
  clearPending.value = undefined;
}

function selectedOption(value: GuobaInput | undefined, option: Scalar): boolean {
  return Array.isArray(value) ? value.includes(option) : value === option;
}

function selectOptions(field: string, schema: GuobaField, event: Event) {
  const options = schema.componentProps?.options ?? [];
  const control = event.target as HTMLSelectElement;
  const values = Array.from(control.selectedOptions).flatMap(({ value }) => {
    const option = value !== "" ? options[Number(value)] : undefined;
    return option ? [option.value] : [];
  });
  update(field, control.multiple ? values : values[0] ?? null);
}

function updateTags(field: string, schema: GuobaField, value: string) {
  tagDrafts.set(field, value);
  const before = savedValue(field);
  const previous = Array.isArray(before) ? before : before === undefined ? [] : [before];
  const candidates = [...previous, ...(schema.componentProps?.options ?? []).map(({ value }) => value)];
  update(field, value.split(/\r?\n/u).filter((entry) => entry.trim() !== "").map((entry) => {
    const index = candidates.findIndex((candidate) => String(candidate) === entry);
    return index === -1 ? entry : candidates[index] as Scalar;
  }));
}

watch(() => props.token, () => {
  active?.abort();
  active = undefined;
  busy.value = undefined;
  selected.value = "";
  plugins.value = [];
  snapshot.value = undefined;
  edits.clear();
  tagDrafts.clear();
  query.value = "";
  readOnly.value = false;
  error.value = "";
  notice.value = "";
  void operate({ kind: "list" });
}, { immediate: true });

onBeforeUnmount(() => {
  active?.abort();
  active = undefined;
  edits.clear();
  emit("dirty-change", false);
});
</script>

<template>
  <section class="plugin-settings" aria-labelledby="plugin-settings-title" :aria-busy="Boolean(busy)">
    <div class="section-heading">
      <h1 id="plugin-settings-title" tabindex="-1">插件配置</h1>
      <ElButton :loading="busy === 'list'" :disabled="Boolean(busy) || Boolean(pending)"
        @click="requestNavigation({ kind: 'list' })">重新载入</ElButton>
    </div>

    <div v-if="plugins.length" class="filters">
      <div>
        <label for="plugin-module">插件</label>
        <select id="plugin-module" :value="selected" :disabled="Boolean(busy) || Boolean(pending)" @change="changePlugin">
          <option disabled value="">请选择插件</option>
          <option v-for="plugin in plugins" :key="plugin" :value="plugin">{{ plugin }}</option>
        </select>
      </div>
      <div v-if="snapshot">
        <label for="plugin-field-search">查找配置项</label>
        <ElInput id="plugin-field-search" v-model="query" placeholder="分组、标签、字段名或说明" />
      </div>
    </div>
    <div v-if="pending" class="plugin-feedback" role="alert">
      <p>当前表单还有未保存的改动。</p>
      <div class="plugin-actions">
        <ElButton @click="pending = undefined">继续编辑</ElButton>
        <ElButton type="danger" @click="operate(pending)">放弃改动并继续</ElButton>
      </div>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <p v-if="readOnly && snapshot" class="plugin-note" role="status">此配置表单只读。</p>
    <p v-if="!snapshot && busy" class="plugin-note" role="status">正在读取配置…</p>
    <p v-else-if="!plugins.length && !error" class="plugin-note" role="status">当前没有提供配置表单的插件。</p>
    <p v-if="!snapshot && notice" class="plugin-note" role="status">{{ notice }}</p>

    <form v-if="snapshot" @submit.prevent="operate({ kind: 'save' })">
      <fieldset :disabled="Boolean(busy) || readOnly" class="schema-grid" aria-label="插件配置项">
        <template v-for="{ schema, field, id } in rows" :key="id">
          <h2 v-if="schema.component === 'Divider'" class="schema-divider">{{ schema.label }}</h2>
          <GuobaSubform v-else-if="schema.component === 'GSubForm' && field && snapshot.subforms?.[field]"
            :id="id" :schema="schema" :saved="snapshot.subforms[field]" :edited="edits.get(field) as GuobaSubformEdit | undefined"
            @update="value => value ? edits.set(field, value) : edits.delete(field)" />
          <div v-else-if="field" class="plugin-field">
            <label :for="id">{{ schema.label }}</label>
            <template v-if="schema.component === 'InputPassword'">
              <ElInput
                :id="id" type="password" autocomplete="new-password"
                :model-value="displayText(edits.get(field) as GuobaInput | undefined)"
                :disabled="Boolean(busy) || readOnly || edits.get(field) === null"
                placeholder="留空保留现有密码"
                @update:model-value="changePassword(field, $event)"
              />
              <div class="password-controls">
                <template v-if="edits.get(field) === null">
                  <span>保存后清除</span>
                  <ElButton @click="edits.delete(field)">撤销清除</ElButton>
                </template>
                <template v-else-if="clearPending === field">
                  <span>清除后可能需要重新配置。</span>
                  <ElButton @click="clearPending = undefined">取消</ElButton>
                  <ElButton type="danger" :aria-label="`确认清除 ${schema.label}`"
                    @click="edits.set(field, null); clearPending = undefined">确认清除</ElButton>
                </template>
                <template v-else-if="snapshot.configuredPasswords.includes(field)">
                  <span>已配置密码</span>
                  <ElButton :aria-label="`清除 ${schema.label}`" @click="clearPending = field">清除密码</ElButton>
                </template>
                <span v-else>尚未配置密码</span>
              </div>
            </template>
            <input
              v-else-if="schema.component === 'Switch'"
              :id="id" type="checkbox" :checked="fieldValue(field) === true"
              @change="updateSwitch(field, $event)"
            />
            <input
              v-else-if="schema.component === 'InputNumber'"
              :id="id" type="number" :value="displayText(fieldValue(field))"
              :placeholder="schema.componentProps?.placeholder" :min="schema.componentProps?.min"
              :max="schema.componentProps?.max" :step="schema.componentProps?.step ?? 'any'"
              @input="updateNumber(field, $event)"
            />
            <template v-else-if="schema.component === 'Select'">
              <template v-if="schema.componentProps?.mode === 'tags'">
                <ElInput
                  :id="id" type="textarea" :rows="3" :model-value="tagDrafts.get(field) ?? displayText(fieldValue(field))"
                  :disabled="Boolean(busy) || readOnly" placeholder="每行一个标签"
                  @update:model-value="updateTags(field, schema, $event)"
                />
              </template>
              <template v-else>
                <select
                  :id="id" :multiple="schema.componentProps?.mode === 'multiple'"
                  :disabled="!schema.componentProps?.options?.length" @change="selectOptions(field, schema, $event)"
                >
                  <option
                    v-if="schema.componentProps?.mode !== 'multiple'"
                    value="" disabled
                    :selected="!schema.componentProps?.options?.some((option) => selectedOption(fieldValue(field), option.value))"
                  >{{ displayText(fieldValue(field)) || schema.componentProps?.placeholder || "请选择" }}</option>
                  <option
                    v-for="(option, index) in schema.componentProps?.options"
                    :key="index" :value="index" :disabled="option.disabled"
                    :selected="selectedOption(fieldValue(field), option.value)"
                  >{{ option.label }}</option>
                </select>
                <p v-if="!schema.componentProps?.options?.length" class="plugin-help">插件未提供可供选择的值。</p>
              </template>
            </template>
            <ElInput
              v-else-if="schema.component === 'InputTextArea'"
              :id="id" type="textarea" :rows="schema.componentProps?.rows ?? 3"
              :model-value="displayText(fieldValue(field))" :placeholder="schema.componentProps?.placeholder"
              :disabled="Boolean(busy) || readOnly"
              @update:model-value="update(field, $event)"
            />
            <template v-else>
              <input :id="id" :value="displayText(fieldValue(field))" :placeholder="schema.componentProps?.placeholder"
                @input="updateText(field, $event)" />
              <p v-if="schema.component === 'EasyCron'" class="plugin-help">填写插件接受的 Cron 表达式。</p>
            </template>
            <p v-if="schema.bottomHelpMessage" class="plugin-help">{{ schema.bottomHelpMessage }}</p>
          </div>
        </template>
        <p v-if="!rows.length" class="plugin-help">没有符合条件的配置项。</p>
      </fieldset>

      <div class="plugin-feedback save-group">
        <p v-if="notice || dirty" role="status">{{ dirty ? "有未保存的改动" : notice }}</p>
        <ElButton v-if="!readOnly" type="primary" native-type="submit"
          :loading="busy === 'save'" :disabled="!dirty || Boolean(busy) || Boolean(pending)">
          保存配置
        </ElButton>
      </div>
    </form>
  </section>
</template>

<style scoped>
.filters > div {
  display: grid;
  width: min(240px, 100%);
  gap: 6px;
  align-content: start;
}
.filters .el-input { width: 100%; }

.plugin-note, .plugin-help {
  color: var(--muted);
  font-size: 14px;
  line-height: 1.5;
}

.plugin-note { margin-top: 16px; }

.schema-grid {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px 20px;
  margin: 18px 0 0;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: 15px;
  background: var(--surface);
}

.schema-divider { grid-column: 1 / -1; padding: 8px 0; border-bottom: 1px solid var(--line); }
.schema-divider:first-child { padding-top: 0; }
.plugin-field { min-width: 0; display: grid; gap: 6px; align-content: start; }
.plugin-field label, .filters label { font-size: 14px; font-weight: 600; }

.plugin-field :is(input:not([type="checkbox"]), select) {
  min-height: 38px;
  width: 100%;
  padding: 0 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  font-size: 14px;
}
.plugin-field select[multiple] { min-height: 80px; padding: 4px 8px; }
.plugin-field :is(input, select):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.plugin-field input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--accent); }

.plugin-feedback, .plugin-actions, .password-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.plugin-feedback {
  margin-top: 14px;
  justify-content: space-between;
  color: var(--muted);
  font-size: 14px;
}
.plugin-actions > .el-button, .password-controls > .el-button { margin: 0; }
.save-group {
  position: sticky;
  bottom: 0;
  padding: 10px 0;
  background: #f4f7f4;
}
.save-group > .el-button { margin-inline-start: auto; }
.password-controls { color: var(--muted); font-size: 13px; }
.password-controls .el-button { --el-button-size: 32px; }

@media (max-width: 640px) {
  .schema-grid { grid-template-columns: 1fr; padding: 14px; }
  .filters > div { flex: 1; width: auto; min-width: 0; }
}
</style>
