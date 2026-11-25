<script setup lang="ts">
import { panelText } from './i18n.ts';

import { computed, ref, watch } from "vue";
import { ElButton } from "element-plus";

const props = defineProps<{ disabled: boolean; legacy: boolean }>();
type Value = string | number | boolean | string[] | null;
type Rule = Record<string, Value>;
const rules = defineModel<Record<string, unknown>>({ required: true });
const scope = ref("default");
const scopeKind = ref<"bot" | "group" | "bot-group">("group");
const botId = ref("");
const groupId = ref("");
const scopes = computed(() => [...new Set(["default", ...Object.keys(rules.value), scope.value])]);
const current = computed(() => rules.value[scope.value] as Rule | null | undefined);
const typedLists = new Map<string, { text: string; entries: string[] }>();
watch(scope, () => typedLists.clear());

interface Field {
  key: string;
  label: string;
  type: "number" | "list" | "choices";
  choices?: readonly { label: string; value: number }[];
  max?: number;
  hint?: string;
}

const switches = [{ label: panelText('GroupRoutingSettings.3fd47edce4'), value: 0 }, { label: panelText('GroupRoutingSettings.8da97ddda9'), value: 1 }];
const dispatch: readonly Field[] = [
  { key: "groupCD", label: panelText('GroupRoutingSettings.562ed688e6'), type: "number", max: 2_147_483_647, hint: panelText('GroupRoutingSettings.363784ad3c') },
  { key: "singleCD", label: panelText('GroupRoutingSettings.19d4121e61'), type: "number", max: 2_147_483_647, hint: panelText('GroupRoutingSettings.363784ad3c') },
  { key: "onlyReplyAt", label: panelText('GroupRoutingSettings.9361f5a3a1'), type: "choices", choices: [
    { label: panelText('GroupRoutingSettings.039802f910'), value: 0 },
    { label: panelText('GroupRoutingSettings.6401270e3c'), value: 1 },
    { label: panelText('GroupRoutingSettings.4b58c9a132'), value: 2 },
  ] },
  { key: "botAlias", label: panelText('GroupRoutingSettings.1bfe79152d'), type: "list", hint: panelText('GroupRoutingSettings.9e8d6df4d5') },
  { key: "enable", label: panelText('GroupRoutingSettings.de95a57ca2'), type: "list", hint: panelText('GroupRoutingSettings.b14eccd6eb') },
  { key: "disable", label: panelText('GroupRoutingSettings.e91ef4c88d'), type: "list", hint: panelText('GroupRoutingSettings.dee1c57c9b') },
];
const keywords: readonly Field[] = [
  { key: "addLimit", label: panelText('GroupRoutingSettings.96d5d8d473'), type: "choices", choices: [
    { label: panelText('GroupRoutingSettings.65feea2c2b'), value: 0 }, { label: panelText('GroupRoutingSettings.de90e11ace'), value: 1 }, { label: panelText('GroupRoutingSettings.6fba0dbf5f'), value: 2 },
  ] },
  { key: "addPrivate", label: panelText('GroupRoutingSettings.5d6eb0971a'), type: "choices", choices: switches },
  { key: "addReply", label: panelText('GroupRoutingSettings.47778620d7'), type: "choices", choices: switches },
  { key: "addAt", label: panelText('GroupRoutingSettings.8c2cc69f87'), type: "choices", choices: switches },
  { key: "addRecall", label: panelText('GroupRoutingSettings.c45c8f7579'), type: "number", max: 2_147_483_647,
    hint: panelText('GroupRoutingSettings.924f0898d9') },
];

function scopeLabel(key: string) {
  if (key === "default") return panelText('GroupRoutingSettings.419bf8bc14');
  const [first, second] = key.split(":");
  if (!second) return panelText('GroupRoutingSettings.b053cdf42f', { value1: first });
  return second === "default" ? panelText('GroupRoutingSettings.620523332e', { value1: first }) : panelText('GroupRoutingSettings.ffeb6e6e89', { value1: first, value2: second });
}

function validId(value: string) {
  return /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value));
}

const newScope = computed(() => {
  const bot = botId.value.trim();
  const group = groupId.value.trim();
  if (scopeKind.value === "bot") return validId(bot) ? `${bot}:default` : "";
  if (scopeKind.value === "group") return validId(group) ? group : "";
  return validId(bot) && validId(group) ? `${bot}:${group}` : "";
});

function setField(key: string, value?: Value) {
  if (value === undefined && !Object.hasOwn(current.value ?? {}, key)) return;
  const next = { ...current.value };
  if (value === undefined) delete next[key];
  else next[key] = value;
  rules.value = { ...rules.value, [scope.value]: next };
}

function clearScope() {
  typedLists.clear();
  const next = { ...rules.value };
  delete next[scope.value];
  rules.value = next;
}

function mode(field: Field) {
  const value = current.value?.[field.key];
  if (value === undefined) return "inherit";
  if (value === null) return "null";
  return field.type === "choices" ? String(Number(value)) : "value";
}

function setMode(field: Field, event: Event) {
  typedLists.delete(field.key);
  const value = (event.target as HTMLSelectElement).value;
  if (value === "inherit") setField(field.key);
  else if (value === "null") setField(field.key, null);
  else if (field.type === "choices") setField(field.key, Number(value));
  else if (field.type === "number") setField(field.key, 0);
  else setField(field.key, []);
}

function setNumber(key: string, event: Event) {
  const value = (event.target as HTMLInputElement).value;
  setField(key, value === "" ? "" : Number(value));
}

function listText(key: string) {
  const value = current.value?.[key];
  const typed = typedLists.get(key);
  if (typed && Array.isArray(value) && value.length === typed.entries.length &&
    value.every((entry, index) => entry === typed.entries[index])) return typed.text;
  return Array.isArray(value) ? value.join("\n") : String(value ?? "");
}

function setList(key: string, event: Event) {
  const text = (event.target as HTMLTextAreaElement).value;
  const entries = text.split(/\r?\n/u).filter(line => line.length > 0);
  typedLists.set(key, { text, entries });
  setField(key, entries);
}
</script>

<template>
  <div class="routing">
    <div class="routing-field">
      <label for="group-routing-scope">{{ panelText('GroupRoutingSettings.0d3d6d62a1') }}</label>
      <select id="group-routing-scope" v-model="scope" :disabled="disabled">
        <option v-for="key in scopes" :key="key" :value="key">{{ scopeLabel(key) }}</option>
      </select>
      <span class="routing-hint">{{ panelText('GroupRoutingSettings.38453138f0') }}</span>
      <span v-if="legacy && scope === 'default'" class="routing-hint">{{ panelText('GroupRoutingSettings.09e57e1377') }}</span>
      <span v-if="current === null" class="routing-hint">{{ panelText('GroupRoutingSettings.82d0da5ccd') }}</span>
      <span v-else-if="current && Object.keys(current).length === 0" class="routing-hint">{{ panelText('GroupRoutingSettings.9280dbd320') }}</span>
    </div>
    <details>
      <summary>{{ panelText('GroupRoutingSettings.4d0e25b6d2') }}</summary>
      <div class="routing-scope-inputs">
        <label>{{ panelText('GroupRoutingSettings.b0984d9882') }}
          <select v-model="scopeKind" :disabled="disabled">
            <option value="group">{{ panelText('GroupRoutingSettings.0df737cb62') }}</option>
            <option value="bot">{{ panelText('GroupRoutingSettings.67715b6e17') }}</option>
            <option value="bot-group">{{ panelText('GroupRoutingSettings.a109dbdfe0') }}</option>
          </select>
        </label>
        <label v-if="scopeKind !== 'group'">{{ panelText('GroupRoutingSettings.327aea256b') }}
          <input v-model="botId" inputmode="numeric" :disabled="disabled">
        </label>
        <label v-if="scopeKind !== 'bot'">{{ panelText('GroupRoutingSettings.27c2162469') }}
          <input v-model="groupId" inputmode="numeric" :disabled="disabled">
        </label>
        <ElButton :disabled="disabled || !newScope" @click="scope = newScope">{{ panelText('GroupRoutingSettings.73a9cf6d1f') }}</ElButton>
      </div>
    </details>
    <fieldset v-for="section in [{ label: panelText('GroupRoutingSettings.782eb2d21c'), fields: dispatch }, { label: panelText('GroupRoutingSettings.1f7f0db90f'), fields: keywords }]"
      :key="section.label" :disabled="disabled">
      <legend>{{ section.label }}</legend>
      <div v-for="field in section.fields" :key="field.key" class="routing-field">
        <label :for="'routing-mode-' + field.key">{{ field.label }}</label>
        <select :id="'routing-mode-' + field.key" :value="mode(field)" @change="setMode(field, $event)">
          <option value="inherit">{{ legacy && scope === 'default' ? panelText('GroupRoutingSettings.733cd5c458') : panelText('GroupRoutingSettings.49f1e2b9d1') }}</option>
          <option v-for="choice in field.choices" :key="choice.value" :value="String(choice.value)">{{ choice.label }}</option>
          <option v-if="field.type !== 'choices'" value="value">{{ panelText('GroupRoutingSettings.2f6770592f', { value1: field.type === 'list' ? panelText('GroupRoutingSettings.aedd6814ff') : '' }) }}</option>
          <option value="null">{{ panelText('GroupRoutingSettings.1d43b8a521') }}</option>
        </select>
        <input v-if="field.type === 'number' && mode(field) === 'value'" type="number" min="0" step="1" required
          :max="field.max" :aria-label="field.label + panelText('GroupRoutingSettings.c5500a58e0')" :value="current?.[field.key] as string | number"
          @input="setNumber(field.key, $event)">
        <textarea v-if="field.type === 'list' && mode(field) === 'value'" rows="3"
          :aria-label="field.label + panelText('GroupRoutingSettings.aedd6814ff')" :value="listText(field.key)" @input="setList(field.key, $event)" />
        <span v-if="field.hint" class="routing-hint">{{ field.hint }}</span>
      </div>
    </fieldset>
    <div>
      <ElButton :disabled="disabled || current === undefined" @click="clearScope">{{ panelText('GroupRoutingSettings.c21441f37e') }}</ElButton>
    </div>
  </div>
</template>

<style scoped>
.routing { display: grid; gap: 16px; }
.routing-field { display: grid; gap: 6px; min-width: 0; }
.routing-hint { color: var(--el-text-color-secondary); font-size: .875rem; overflow-wrap: anywhere; }
.routing-scope-inputs { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); align-items: end; gap: 10px; margin-top: 10px; }
.routing-scope-inputs label { display: grid; gap: 6px; }
fieldset {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  align-items: start; gap: 14px; min-width: 0; margin: 0; padding: 12px;
  border: 1px solid var(--el-border-color); border-radius: 4px;
}
legend { padding: 0 4px; font-weight: 600; }
summary { cursor: pointer; }
input, select, textarea {
  width: 100%; min-width: 0; min-height: 34px; padding: 6px 9px;
  color: var(--el-text-color-primary); background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color); border-radius: 4px; font: inherit;
}
textarea { resize: vertical; }
</style>
