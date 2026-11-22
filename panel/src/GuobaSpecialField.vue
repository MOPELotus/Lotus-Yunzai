<script setup lang="ts">
import { ElDatePicker, ElTimePicker, ElTreeSelect } from "element-plus";
import "element-plus/es/components/date-picker/style/css";
import "element-plus/es/components/time-picker/style/css";
import "element-plus/es/components/tree-select/style/css";
import { computed, ref, watch } from "vue";
import type { GuobaField, GuobaInput } from "../../lib/panel-guoba.ts";

type Item = Exclude<GuobaInput, unknown[]>;
const props = defineProps<{ id: string; schema: GuobaField; value?: GuobaInput; disabled?: boolean; required?: boolean }>();
const emit = defineEmits<{ update: [value: GuobaInput] }>();
const options = computed(() => props.schema.componentProps?.options ?? []);
const contact = computed(() => props.schema.component === "GSelectGroup" || props.schema.component === "GSelectFriend");
const items = computed(() => Array.isArray(props.value) ? props.value : []);
const draft = ref("");
const dateType = computed(() => props.schema.componentProps?.dateType ?? "date");
const valueFormat = computed(() => props.schema.componentProps?.valueFormat ??
  (props.schema.component === "TimePicker" ? "HH:mm:ss" :
    dateType.value === "datetime" ? "YYYY-MM-DD HH:mm:ss" : "YYYY-MM-DD"));
const pickerValue = computed(() => typeof props.value === "string" || typeof props.value === "number" ? props.value : undefined);
const color = computed(() => typeof props.value === "string" ? props.value : "");
const treeValue = computed(() => Array.isArray(props.value)
  ? props.value.filter(item => typeof item === "string" || typeof item === "number") : pickerValue.value);

watch(() => props.id, () => { draft.value = ""; });

function text(event: Event) { return (event.target as HTMLInputElement).value; }

function contactValue(value: string): Item {
  return options.value.find(option => String(option.value) === value)?.value ??
    (typeof props.value === "number" && Number.isSafeInteger(Number(value)) ? Number(value) : value);
}

function add() {
  const value = draft.value.trim();
  if (props.disabled || !value || (contact.value && !/^[1-9][0-9]*$/u.test(value))) return;
  const number = Number(value);
  const next = contact.value ? contactValue(value) :
    props.schema.componentProps?.numeric && /^\d+$/u.test(value) && Number.isSafeInteger(number) ? number : value;
  if (!items.value.some(item => String(item) === String(next))) emit("update", [...items.value, next]);
  draft.value = "";
}

function selectTags(event: Event) {
  const control = event.target as HTMLSelectElement;
  emit("update", [...control.selectedOptions].flatMap(option => {
    const item = options.value[Number(option.value)];
    return item ? [item.value] : [];
  }));
}

function updatePicker(value: unknown) {
  if (value == null || typeof value === "string" || typeof value === "number") emit("update", value ?? null);
}

function updateTree(value: unknown) {
  if (Array.isArray(value) && value.every(item => typeof item === "string" || typeof item === "number")) {
    emit("update", value);
  } else updatePicker(value);
}
</script>

<template>
  <div v-if="schema.component === 'GColorPicker'" class="inline-field">
    <input type="color" :value="/^#[0-9a-f]{6}$/iu.test(color) ? color : '#000000'"
      :aria-label="`${schema.label}色板`" :disabled="disabled" @input="emit('update', text($event))" />
    <input :id="id" :value="color" :required="required" :placeholder="schema.componentProps?.placeholder"
      :disabled="disabled" @input="emit('update', text($event))" />
  </div>
  <ElDatePicker v-else-if="schema.component === 'DatePicker'" :id="id" :type="dateType"
    :model-value="pickerValue" :format="schema.componentProps?.format" :value-format="valueFormat"
    :disabled="disabled" :placeholder="schema.componentProps?.placeholder ?? '选择日期'" :teleported="false" @update:model-value="updatePicker" />
  <ElTimePicker v-else-if="schema.component === 'TimePicker'" :id="id" :model-value="pickerValue"
    :format="schema.componentProps?.format" :value-format="valueFormat" :disabled="disabled"
    :placeholder="schema.componentProps?.placeholder ?? '选择时间'" :teleported="false" @update:model-value="updatePicker" />
  <ElTreeSelect v-else-if="schema.component === 'TreeSelect'" :id="id" :model-value="treeValue"
    :data="schema.componentProps?.treeData ? [...schema.componentProps.treeData] : []"
    :multiple="schema.componentProps?.multiple" :show-checkbox="schema.componentProps?.treeCheckable"
    :check-strictly="!schema.componentProps?.treeCheckable" :disabled="disabled"
    :placeholder="schema.componentProps?.placeholder ?? '选择分类'" :teleported="false" clearable filterable @update:model-value="updateTree" />
  <template v-else-if="contact && schema.componentProps?.single">
    <input :id="id" inputmode="numeric" pattern="[1-9][0-9]*" :value="pickerValue" :list="`${id}-options`"
      :required="required" :placeholder="schema.componentProps.placeholder ?? '填入号码'" :disabled="disabled"
      @change="emit('update', text($event) ? contactValue(text($event)) : null)" />
    <datalist :id="`${id}-options`">
      <option v-for="(option, index) in options" :key="index" :value="String(option.value)" :label="option.label" />
    </datalist>
  </template>
  <select v-else-if="schema.component === 'GTags' && options.length" :id="id" multiple
    :required="required" :disabled="disabled" @change="selectTags">
    <option v-for="(option, index) in options" :key="index" :value="index"
      :selected="items.includes(option.value)" :disabled="option.disabled">{{ option.label }}</option>
  </select>
  <div v-else class="tag-field">
    <ul v-if="items.length" class="tag-list">
      <li v-for="(item, index) in items" :key="index">
        {{ options.find(option => option.value === item)?.label ?? item }}
        <button v-if="schema.componentProps?.allowDel !== false" type="button" :disabled="disabled"
          :aria-label="`移除 ${item}`" @click="emit('update', items.filter((_, at) => at !== index))">移除</button>
      </li>
    </ul>
    <div v-if="schema.componentProps?.allowAdd !== false" class="inline-field">
      <input :id="id" v-model="draft" :inputmode="contact ? 'numeric' : undefined" :list="`${id}-options`"
        :placeholder="schema.componentProps?.placeholder ?? (contact ? '填入号码' : '填入标签')"
        :disabled="disabled" @keydown.enter.prevent.stop="add" />
      <button type="button" :disabled="disabled || !draft.trim()" @click="add">添加</button>
    </div>
    <datalist :id="`${id}-options`">
      <option v-for="(option, index) in options" :key="index" :value="String(option.value)" :label="option.label" />
    </datalist>
  </div>
</template>

<style scoped>
.inline-field, .tag-list, .tag-list li { display: flex; gap: 8px; align-items: center; }
.inline-field input:not([type="color"]) { flex: 1; min-width: 0; }
.inline-field input[type="color"] { flex: 0 0 55px; width: 55px; padding: 4px; }
.el-date-editor.el-input { width: 100%; }
.tag-list { flex-wrap: wrap; list-style: none; margin: 0 0 8px; padding: 0; }
.tag-list li { border: 1px solid var(--line, #d9e0e3); border-radius: 6px; padding: 2px 6px; overflow-wrap: anywhere; }
button { cursor: pointer; }
button:disabled { cursor: default; }
</style>
