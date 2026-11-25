<script setup lang="ts">
import { panelText } from './i18n.ts';

import { ElButton, ElInput } from "element-plus";
import { computed, onBeforeUnmount, provide, reactive, ref, shallowRef, watch } from "vue";
import GuobaSubform from "./GuobaSubform.vue";
import GuobaSpecialField from "./GuobaSpecialField.vue";
import type { GuobaButton, GuobaEdit, GuobaField, GuobaInput, GuobaSubformEdit, GuobaSubformSnapshot } from "../../lib/panel-guoba.ts";
import { panelFetch, type PanelAuth } from "./api.ts";
import { guobaPanelAuth, isSpecialGuobaField } from "./guoba-fields.ts";

const props = defineProps<{ auth: PanelAuth }>();
provide(guobaPanelAuth, () => props.auth);
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
  actionRevision?: string;
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
const pendingAction = shallowRef<GuobaButton>();
const busy = ref<Operation["kind"] | "action">();
let active: AbortController | undefined;

const dirty = computed(() => edits.size > 0);
const actionFields = computed(() => new Set(snapshot.value?.schemas.flatMap(schema =>
  schema.componentProps?.buttons?.flatMap(button => button.disabled ? [] : [...button.fields]) ?? [])));
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
    if (!groupMatches && ![schema.label, field, schema.bottomHelpMessage,
      ...(schema.componentProps?.buttons ?? []).map(button => button.label)].some(matches)) continue;
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
  if (!isRecord(value) || typeof value.component !== "string" || typeof value.label !== "string" ||
      (value.bottomHelpMessage !== undefined && typeof value.bottomHelpMessage !== "string")) return false;
  if (value.component !== "GButtons") return value.component === "Divider" || typeof value.field === "string";
  return isRecord(value.componentProps) && Array.isArray(value.componentProps.buttons) &&
    value.componentProps.buttons.every(button => isRecord(button) && typeof button.id === "string" &&
      typeof button.label === "string" && strArray(button.fields) &&
      (button.confirm === undefined || typeof button.confirm === "string") &&
      (button.disabled === undefined || button.disabled === true) &&
      (button.type === undefined || button.type === "primary" || button.type === "danger"));
}

async function request(path: string, signal: AbortSignal, body?: Record<string, unknown>,
  method = body ? "PUT" : "GET"): Promise<unknown> {
  const headers = new Headers();
  if (body) headers.set("Content-Type", "application/json");
  const response = await panelFetch(path, props.auth, {
    method, headers, signal, body: body && JSON.stringify(body),
  });
  if (!response.ok) {
    const messages: Record<number, string> = {
      404: panelText('PluginSettings.593d4aed78'),
      409: panelText('PluginSettings.6fd73c34cc'),
      405: panelText('PluginSettings.e982faca97'),
      400: panelText('PluginSettings.e028c4ca5b'),
      422: panelText('PluginSettings.04eb76cf55'),
    };
    throw new RequestError(response.status, messages[response.status] ?? panelText('PluginSettings.6182adeed1'));
  }
  return response.json().catch(() => undefined);
}

async function read(plugin: string, signal: AbortSignal): Promise<Snapshot> {
  const data = await request(`${endpoint}/${encodeURIComponent(plugin)}`, signal);
  if (!isRecord(data) || !Array.isArray(data.schemas) || !data.schemas.every(isSchema) || !isRecord(data.values) ||
      !strArray(data.configuredPasswords)) {
    throw new RequestError(500, panelText('PluginSettings.8585734f4a'));
  }
  return {
    schemas: data.schemas,
    values: data.values as Snapshot["values"],
    configuredPasswords: data.configuredPasswords,
    subforms: isRecord(data.subforms) ? data.subforms as Snapshot["subforms"] : undefined,
    writable: typeof data.writable === "boolean" ? data.writable : undefined,
    actionRevision: typeof data.actionRevision === "string" && /^[a-f0-9]{64}$/u.test(data.actionRevision)
      ? data.actionRevision : undefined,
  };
}

async function operate(operation: Operation) {
  if (active) return;
  if (operation.kind === "save" && (!dirty.value || readOnly.value)) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 14_000);
  active = controller;
  busy.value = operation.kind;
  pending.value = undefined;
  clearPending.value = undefined;
  pendingAction.value = undefined;
  error.value = "";
  notice.value = "";
  let saved = false;
  let plugin = operation.kind === "read" ? operation.plugin : selected.value;
  try {
    if (operation.kind === "list") {
      const result = await request(endpoint, controller.signal);
      if (active !== controller) return;
      if (!isRecord(result) || !strArray(result.plugins)) {
        throw new RequestError(500, panelText('PluginSettings.e06688aa36'));
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
        throw new RequestError(400, panelText('PluginSettings.b024dbaa42'));
      }
      saved = true;
      edits.clear();
      notice.value = typeof result.message === "string" ? result.message : panelText('PluginSettings.09d89ed905');
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
      error.value = panelText('PluginSettings.01a2b17ecc');
    } else {
      error.value = failure instanceof RequestError ? failure.message : panelText('PluginSettings.19818d1a03');
    }
  } finally {
    clearTimeout(timeout);
    if (active === controller) {
      active = undefined;
      busy.value = undefined;
    }
  }
}

function chooseAction(button: GuobaButton) {
  if (active || pending.value || button.disabled || !snapshot.value?.actionRevision) return;
  if (button.confirm) pendingAction.value = button;
  else void runAction(button);
}

async function runAction(button: GuobaButton) {
  const plugin = selected.value;
  const revision = snapshot.value?.actionRevision;
  if (active || !plugin || !revision || button.disabled) return;
  const fields = Object.fromEntries(button.fields.filter(field => edits.has(field)).map(field => [field, edits.get(field)]));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  active = controller;
  busy.value = "action";
  pendingAction.value = undefined;
  error.value = "";
  notice.value = "";
  let completed = false;
  try {
    const result = await request(`${endpoint}/${encodeURIComponent(plugin)}/action`, controller.signal,
      { button: button.id, revision, fields }, "POST");
    if (active !== controller) return;
    if (!isRecord(result) || result.ok !== true) throw new RequestError(500, panelText('PluginSettings.b542846062'));
    completed = true;
    notice.value = panelText('PluginSettings.b25927712a');
    const latest = await read(plugin, controller.signal);
    if (active !== controller) return;
    snapshot.value = latest;
    readOnly.value = latest.writable === false;
  } catch (failure) {
    if (active !== controller) return;
    if (failure instanceof RequestError && failure.status === 401) return emit("unauthorized");
    error.value = completed ? panelText('PluginSettings.87397d5d8b') :
      failure instanceof RequestError && failure.status === 409 ? panelText('PluginSettings.9738ec6fd9') :
      failure instanceof RequestError && [400, 404, 422].includes(failure.status) ? panelText('PluginSettings.194947fa2e') :
      panelText('PluginSettings.09b30a6bdf');
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

function toggleOption(field: string, option: Scalar, event: Event) {
  const current = fieldValue(field);
  const values = Array.isArray(current) ? current.filter(value => value !== option) : [];
  if ((event.target as HTMLInputElement).checked) values.push(option);
  update(field, values);
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

watch(() => props.auth, () => {
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
  pendingAction.value = undefined;
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
      <h1 id="plugin-settings-title" tabindex="-1">{{ panelText('PluginSettings.f782650891') }}</h1>
      <ElButton :loading="busy === 'list'" :disabled="Boolean(busy || pending || pendingAction)"
        @click="requestNavigation({ kind: 'list' })">{{ panelText('PluginSettings.35588dcb9b') }}</ElButton>
    </div>

    <div v-if="plugins.length" class="filters">
      <div>
        <label for="plugin-module">{{ panelText('PluginSettings.e806fbbe8e') }}</label>
        <select id="plugin-module" :value="selected" :disabled="Boolean(busy || pending || pendingAction)" @change="changePlugin">
          <option disabled value="">{{ panelText('PluginSettings.69c36050e6') }}</option>
          <option v-for="plugin in plugins" :key="plugin" :value="plugin">{{ plugin }}</option>
        </select>
      </div>
      <div v-if="snapshot">
        <label for="plugin-field-search">{{ panelText('PluginSettings.1baae1183e') }}</label>
        <ElInput id="plugin-field-search" v-model="query" :placeholder="panelText('PluginSettings.f09e0882f3')" />
      </div>
    </div>
    <div v-if="pendingAction" class="plugin-feedback" role="alert">
      <p>{{ pendingAction.confirm }}</p>
      <div class="plugin-actions">
        <ElButton @click="pendingAction = undefined">{{ panelText('PluginSettings.2cd0f3be87') }}</ElButton>
        <ElButton :type="pendingAction.type ?? 'primary'" @click="runAction(pendingAction)">{{ panelText('PluginSettings.c447e931ac', { value1: pendingAction.label }) }}</ElButton>
      </div>
    </div>
    <div v-if="pending" class="plugin-feedback" role="alert">
      <p>{{ panelText('PluginSettings.35544eda8d') }}</p>
      <div class="plugin-actions">
        <ElButton @click="pending = undefined">{{ panelText('PluginSettings.fd4b9e3b6c') }}</ElButton>
        <ElButton type="danger" @click="operate(pending)">{{ panelText('PluginSettings.181e98c7b5') }}</ElButton>
      </div>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <p v-if="busy === 'action'" class="plugin-note" role="status">{{ panelText('PluginSettings.fb2ef3080f') }}</p>
    <p v-if="readOnly && snapshot" class="plugin-note" role="status">{{ panelText('PluginSettings.e982faca97') }}</p>
    <p v-if="!snapshot && busy" class="plugin-note" role="status">{{ panelText('PluginSettings.8a044dd742') }}</p>
    <p v-else-if="!plugins.length && !error" class="plugin-note" role="status">{{ panelText('PluginSettings.2bc1b7d0c5') }}</p>
    <p v-if="!snapshot && notice" class="plugin-note" role="status">{{ notice }}</p>

    <form v-if="snapshot" @submit.prevent="operate({ kind: 'save' })">
      <fieldset :disabled="Boolean(busy || pendingAction)" class="schema-grid" :aria-label="panelText('PluginSettings.b05d9b7ef4')">
        <template v-for="{ schema, field, id } in rows" :key="id">
          <h2 v-if="schema.component === 'Divider'" class="schema-divider">{{ schema.label }}</h2>
          <fieldset v-else-if="schema.component === 'GSubForm' && field && snapshot.subforms?.[field]"
            class="subform-field" :disabled="readOnly">
            <GuobaSubform
              :id="id" :schema="schema" :saved="snapshot.subforms[field]" :edited="edits.get(field) as GuobaSubformEdit | undefined"
              @update="value => value ? edits.set(field, value) : edits.delete(field)" />
          </fieldset>
          <div v-else-if="schema.component === 'GButtons'" class="plugin-field" role="group" :aria-labelledby="id">
            <span :id="id" class="plugin-field-label">{{ schema.label }}</span>
            <div class="plugin-actions">
              <ElButton v-for="button in schema.componentProps?.buttons" :key="button.id" :type="button.type"
                :disabled="button.disabled || !snapshot.actionRevision || Boolean(pending)"
                @click="chooseAction(button)">{{ button.label }}</ElButton>
            </div>
          </div>
          <fieldset v-else-if="field" class="plugin-field" :disabled="readOnly && !actionFields.has(field)">
            <span v-if="schema.component === 'CheckboxGroup'" :id="id" class="plugin-field-label">{{ schema.label }}</span>
            <label v-else :for="id">{{ schema.label }}</label>
            <template v-if="schema.component === 'InputPassword'">
              <ElInput
                :id="id" type="password" autocomplete="new-password"
                :model-value="displayText(edits.get(field) as GuobaInput | undefined)"
                :disabled="Boolean(busy) || readOnly || edits.get(field) === null"
                :placeholder="panelText('PluginSettings.a1087d5221')"
                @update:model-value="changePassword(field, $event)"
              />
              <div class="password-controls">
                <template v-if="edits.get(field) === null">
                  <span>{{ panelText('PluginSettings.89461376cb') }}</span>
                  <ElButton @click="edits.delete(field)">{{ panelText('PluginSettings.ce1a8af929') }}</ElButton>
                </template>
                <template v-else-if="clearPending === field">
                  <span>{{ panelText('PluginSettings.78e1f45c1e') }}</span>
                  <ElButton @click="clearPending = undefined">{{ panelText('PluginSettings.2cd0f3be87') }}</ElButton>
                  <ElButton type="danger" :aria-label="panelText('PluginSettings.c5b5ad2c0e', { value1: schema.label })"
                    @click="edits.set(field, null); clearPending = undefined">{{ panelText('PluginSettings.a5da1dd8fd') }}</ElButton>
                </template>
                <template v-else-if="snapshot.configuredPasswords.includes(field)">
                  <span>{{ panelText('PluginSettings.dc7f1aad22') }}</span>
                  <ElButton :aria-label="panelText('PluginSettings.52b841bf13', { value1: schema.label })" @click="clearPending = field">{{ panelText('PluginSettings.a57cdd7b49') }}</ElButton>
                </template>
                <span v-else>{{ panelText('PluginSettings.02db2acbc6') }}</span>
              </div>
            </template>
            <GuobaSpecialField v-else-if="isSpecialGuobaField(schema)" :id="id" :schema="schema" :value="fieldValue(field)"
              :disabled="Boolean(busy) || (readOnly && !actionFields.has(field))" @update="update(field, $event)" />
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
            <div v-else-if="schema.component === 'CheckboxGroup'"
              class="plugin-actions checkbox-group" role="group" :aria-labelledby="id">
              <label v-for="(option, index) in schema.componentProps?.options" :key="index">
                <input type="checkbox" :checked="selectedOption(fieldValue(field), option.value)" :disabled="option.disabled"
                  @change="toggleOption(field, option.value, $event)" />
                {{ option.label }}
              </label>
            </div>
            <template v-else-if="schema.component === 'Select'">
              <template v-if="schema.componentProps?.mode === 'tags'">
                <ElInput
                  :id="id" type="textarea" :rows="3" :model-value="tagDrafts.get(field) ?? displayText(fieldValue(field))"
                  :disabled="Boolean(busy) || (readOnly && !actionFields.has(field))" :placeholder="panelText('PluginSettings.e213c5fd9a')"
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
                  >{{ displayText(fieldValue(field)) || schema.componentProps?.placeholder || panelText('PluginSettings.da590a8fe3') }}</option>
                  <option
                    v-for="(option, index) in schema.componentProps?.options"
                    :key="index" :value="index" :disabled="option.disabled"
                    :selected="selectedOption(fieldValue(field), option.value)"
                  >{{ option.label }}</option>
                </select>
                <p v-if="!schema.componentProps?.options?.length" class="plugin-help">{{ panelText('PluginSettings.945835564d') }}</p>
              </template>
            </template>
            <ElInput
              v-else-if="schema.component === 'InputTextArea'"
              :id="id" type="textarea" :rows="schema.componentProps?.rows ?? 3"
              :model-value="displayText(fieldValue(field))" :placeholder="schema.componentProps?.placeholder"
              :disabled="Boolean(busy) || (readOnly && !actionFields.has(field))"
              @update:model-value="update(field, $event)"
            />
            <template v-else>
              <input :id="id" :value="displayText(fieldValue(field))" :placeholder="schema.componentProps?.placeholder"
                @input="updateText(field, $event)" />
              <p v-if="schema.component === 'EasyCron'" class="plugin-help">{{ panelText('PluginSettings.6f9d38fecb') }}</p>
            </template>
            <p v-if="schema.bottomHelpMessage" class="plugin-help">{{ schema.bottomHelpMessage }}</p>
          </fieldset>
        </template>
        <p v-if="!rows.length" class="plugin-help">{{ panelText('PluginSettings.4356c975a3') }}</p>
      </fieldset>

      <div class="plugin-feedback save-group">
        <p v-if="notice" role="status">{{ notice }}</p>
        <p v-if="dirty" role="status">{{ readOnly ? panelText('PluginSettings.98d58781d0') : panelText('PluginSettings.535083c5e5') }}</p>
        <ElButton v-if="!readOnly" type="primary" native-type="submit"
          :loading="busy === 'save'" :disabled="!dirty || Boolean(busy || pending || pendingAction)">
          {{ panelText('PluginSettings.6e584e3d5c') }}
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
.plugin-field, .subform-field { min-width: 0; margin: 0; padding: 0; border: 0; }
.plugin-field { display: grid; gap: 6px; align-content: start; }
.subform-field { grid-column: 1 / -1; }
.plugin-field label, .plugin-field-label, .filters label { font-size: 14px; font-weight: 600; }
.checkbox-group label { display: inline-flex; align-items: center; gap: 5px; font-weight: 400; }

.plugin-field :is(input:not([type="checkbox"], .el-input__inner, .el-select__input, .el-cascader__search-input), select) {
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
.plugin-field :is(input:not(.el-input__inner, .el-select__input, .el-cascader__search-input), select):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
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
