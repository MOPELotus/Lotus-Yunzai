<script setup lang="ts">
import { ElCascader, ElDatePicker, ElRate, ElSlider, ElTimePicker, ElTreeSelect, type CascaderOption } from "element-plus";
import "element-plus/es/components/cascader/style/css";
import "element-plus/es/components/date-picker/style/css";
import "element-plus/es/components/rate/style/css";
import "element-plus/es/components/slider/style/css";
import "element-plus/es/components/time-picker/style/css";
import "element-plus/es/components/tree-select/style/css";
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import type { GuobaField, GuobaInput, GuobaPath, GuobaTreeNode } from "../../lib/panel-guoba.ts";
import { panelFetch } from "./api.ts";
import { guobaPanelAuth } from "./guoba-fields.ts";

type Item = Exclude<GuobaInput, unknown[]>;
const props = defineProps<{ id: string; schema: GuobaField; value?: GuobaInput; disabled?: boolean; required?: boolean }>();
const emit = defineEmits<{ update: [value: GuobaInput] }>();
const options = computed(() => props.schema.componentProps?.options ?? []);
const contact = computed(() => props.schema.component === "GSelectGroup" || props.schema.component === "GSelectFriend");
const contactTitle = computed(() => props.schema.component === "GSelectGroup" ? "群" : "好友");
const auth = inject(guobaPanelAuth);
const items = computed(() => Array.isArray(props.value) ? props.value.filter((item): item is Item => !Array.isArray(item)) : []);
const draft = ref("");
const dateType = computed(() => props.schema.componentProps?.dateType ?? "date");
const valueFormat = computed(() => props.schema.componentProps?.valueFormat ??
  (props.schema.component === "TimePicker" ? "HH:mm:ss" :
    dateType.value === "datetime" ? "YYYY-MM-DD HH:mm:ss" : "YYYY-MM-DD"));
const pickerValue = computed(() => typeof props.value === "string" || typeof props.value === "number" ? props.value : undefined);
const color = computed(() => typeof props.value === "string" ? props.value : "");
const treeValue = computed(() => Array.isArray(props.value)
  ? props.value.filter(item => typeof item === "string" || typeof item === "number") : pickerValue.value);
function cascaderOptions(nodes: readonly GuobaTreeNode[]): CascaderOption[] {
  return nodes.map(({ label, value, disabled, children }) => ({
    label, value, disabled, ...(children?.length ? { children: cascaderOptions(children) } : {}),
  }));
}
const cascader = computed(() => cascaderOptions(props.schema.componentProps?.treeData ?? []));
function isPath(value: unknown): value is GuobaPath {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string" || typeof item === "number");
}
const cascaderValue = computed(() => {
  const value = props.value;
  if (props.schema.componentProps?.multiple) return Array.isArray(value) ? value.filter(isPath) : [];
  return isPath(value) ? value : [];
});
const sliderMarks = computed(() => Object.keys(props.schema.componentProps?.marks ?? {}).map(Number).sort((a, b) => a - b));
const sliderLimits = computed(() => {
  const { min = 0, max = 100, marksOnly } = props.schema.componentProps ?? {};
  return marksOnly ? { min: 0, max: Math.max(1, sliderMarks.value.length - 1) } : { min, max };
});
const sliderLabels = computed(() => props.schema.componentProps?.marksOnly
  ? Object.fromEntries(sliderMarks.value.map((value, index) => [index, props.schema.componentProps?.marks?.[value] ?? String(value)]))
  : props.schema.componentProps?.marks);
const sliderValue = computed(() => Array.isArray(props.value)
  ? props.value.filter(item => typeof item === "number")
  : typeof props.value === "number" ? props.value
    : props.schema.componentProps?.multiple ? [props.schema.componentProps.min ?? 0, props.schema.componentProps.max ?? 100]
      : props.schema.componentProps?.min ?? 0);
const displayedSliderValue = computed(() => {
  if (!props.schema.componentProps?.marksOnly) return sliderValue.value;
  const index = (entry: number) => Math.max(0, sliderMarks.value.indexOf(entry));
  return Array.isArray(sliderValue.value) ? sliderValue.value.map(index) : index(sliderValue.value);
});
const cronPresets = [
  { label: "每分钟", value: "0 * * * * ?" },
  { label: "每小时", value: "0 0 * * * ?" },
  { label: "每天 0 点", value: "0 0 0 * * ?" },
  { label: "每天 8 点", value: "0 0 8 * * ?" },
  { label: "每天 0:02", value: "0 2 0 * * ?" },
  { label: "每周一 8 点", value: "0 0 8 ? * 1" },
  { label: "每月 1 号 0 点", value: "0 0 0 1 * ?" },
];
const cronText = computed(() => typeof props.value === "string" ? props.value : "");
const cronSize = computed(() => cronText.value.trim().split(/\s+/u).length);
const cronDescription = computed(() => {
  const expr = cronText.value.trim();
  const preset = cronPresets.find(item => item.value === expr);
  if (preset) return preset.label;
  const fields = expr.split(/\s+/u);
  if (fields.length === 5) fields.unshift("0");
  if (fields.length !== 6) return;
  const [second, minute, hour, day, month, weekday] = fields as [string, string, string, string, string, string];
  const any = (part: string) => part === "*" || part === "?";
  const fits = (part: string, min: number, max: number) =>
    /^\d+$/u.test(part) && Number(part) >= min && Number(part) <= max;
  if (!any(month) || !fits(second, 0, 59) || !fits(minute, 0, 59) || !fits(hour, 0, 23)) return;
  const clock = (Number(second) === 0 ? [hour, minute] : [hour, minute, second]).map(part => part.padStart(2, "0")).join(":");
  if (any(day) && any(weekday)) return `每天 ${clock}`;
  if (any(day) && fits(weekday, 0, 7)) return `每周${"日一二三四五六"[Number(weekday) % 7]} ${clock}`;
  if (any(weekday) && fits(day, 1, 31)) return `每月 ${Number(day)} 号 ${clock}`;
});

type Contact = { readonly id: number; readonly name?: string };
const query = ref("");
const matches = ref<readonly Contact[]>([]);
const chosenNames = ref<Record<number, string>>({});
const page = ref(0);
const nextPage = ref(false);
const contactMessage = ref("");
const searching = ref(false);
let active: AbortController | undefined;
let lastQuery = "";

watch(() => [props.id, props.schema], () => {
  active?.abort();
  active = undefined;
  draft.value = "";
  query.value = "";
  page.value = 0;
  matches.value = [];
  chosenNames.value = {};
  nextPage.value = false;
  contactMessage.value = "";
  searching.value = false;
});
onBeforeUnmount(() => active?.abort());

function text(event: Event) { return (event.target as HTMLInputElement).value; }

function contactValue(value: string): Item {
  return options.value.find(option => String(option.value) === value)?.value ??
    (typeof props.value === "number" && Number.isSafeInteger(Number(value)) ? Number(value) : value);
}

function label(item: Item) {
  return options.value.find(option => option.value === item)?.label ?? chosenNames.value[Number(item)] ?? item;
}

function pickContact(item: Contact) {
  const value = options.value.find(option => String(option.value) === String(item.id))?.value ?? item.id;
  if (item.name) chosenNames.value = { ...chosenNames.value, [item.id]: item.name };
  if (props.schema.componentProps?.single) emit("update", value);
  else if (!items.value.some(selected => String(selected) === String(item.id))) emit("update", [...items.value, value]);
}

async function searchContacts(requested: number) {
  const session = auth?.();
  if (session?.kind !== "session" || props.disabled) return;
  if (requested === 1) lastQuery = query.value.trim();
  active?.abort();
  const request = active = new AbortController();
  searching.value = true;
  contactMessage.value = "";
  try {
    const response = await panelFetch(`${import.meta.env.BASE_URL}api/session/contacts`, session, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: request.signal,
      body: JSON.stringify({ kind: props.schema.component === "GSelectGroup" ? "group" : "friend", query: lastQuery, page: requested }),
    });
    if (request.signal.aborted) return;
    if (response.status === 403) {
      matches.value = [];
      page.value = 0;
      nextPage.value = false;
      contactMessage.value = "请从对应机器人的好友私聊重新打开管理面板，也可直接填入号码。";
      return;
    }
    if (!response.ok) throw new Error();
    const result = await response.json() as { items: Contact[]; next: boolean };
    if (request.signal.aborted) return;
    matches.value = result.items;
    page.value = requested;
    nextPage.value = result.next;
    if (!matches.value.length) contactMessage.value = "当前页没有匹配项。";
  } catch {
    if (!request.signal.aborted) contactMessage.value = "暂时无法读取名录，可直接填入号码。";
  } finally {
    if (active === request) searching.value = false;
  }
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

function updateCascader(value: unknown) {
  if (value == null) {
    emit("update", []);
    return;
  }
  const paths = props.schema.componentProps?.multiple && Array.isArray(value) ? value.every(isPath) : isPath(value);
  if (Array.isArray(value) && (value.length === 0 || paths)) emit("update", value);
}

function updateSlider(value: unknown) {
  if (!props.schema.componentProps?.marksOnly) return updateTree(value);
  const mark = (index: unknown) => typeof index === "number" ? sliderMarks.value[index] : undefined;
  const next = Array.isArray(value) ? value.map(mark) : mark(value);
  updateTree(next);
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
    :check-strictly="!schema.componentProps?.treeCheckable || schema.componentProps?.treeCheckStrictly" :disabled="disabled"
    :placeholder="schema.componentProps?.placeholder ?? '选择分类'" :teleported="false" clearable filterable @update:model-value="updateTree" />
  <ElCascader v-else-if="schema.component === 'Cascader'" :id="id"
    :model-value="cascaderValue" :options="cascader"
    :props="{ multiple: schema.componentProps?.multiple, checkStrictly: schema.componentProps?.changeOnSelect }"
    :disabled="disabled" :placeholder="schema.componentProps?.placeholder ?? '请选择'"
    :teleported="false" clearable filterable @update:model-value="updateCascader" />
  <ElSlider v-else-if="schema.component === 'Slider'" :id="id" :model-value="displayedSliderValue"
    :min="sliderLimits.min" :max="sliderLimits.max" :step="schema.componentProps?.step" :marks="sliderLabels"
    :format-tooltip="schema.componentProps?.marksOnly ? index => String(sliderMarks[index] ?? sliderMarks.at(-1)) : undefined"
    :range="schema.componentProps?.multiple" :aria-label="schema.label"
    :disabled="disabled || (schema.componentProps?.marksOnly && sliderMarks.length === 1)" @update:model-value="updateSlider" />
  <ElRate v-else-if="schema.component === 'Rate'" :id="id" :model-value="typeof value === 'number' ? value : 0"
    :max="schema.componentProps?.count" :allow-half="schema.componentProps?.allowHalf" :aria-label="schema.label"
    :disabled="disabled" clearable @update:model-value="updatePicker" />
  <template v-else-if="schema.component === 'AutoComplete'">
    <input :id="id" type="text" :list="`${id}-suggestions`" :value="value ?? ''"
      :required="required" :disabled="disabled" :placeholder="schema.componentProps?.placeholder" @input="emit('update', text($event))" />
    <datalist :id="`${id}-suggestions`">
      <option v-for="(option, index) in options.filter(item => !item.disabled)" :key="index" :value="String(option.value)" :label="option.label" />
    </datalist>
  </template>
  <div v-else-if="schema.component === 'EasyCron'" class="cron-field">
    <input :id="id" type="text" :value="cronText" :required="required" :disabled="disabled"
      :placeholder="schema.componentProps?.placeholder ?? '如 0 0 8 * * ?'" @input="emit('update', text($event))" />
    <details>
      <summary>常用计划</summary>
      <div class="cron-presets">
        <button v-for="item in cronPresets" :key="item.value" type="button" :disabled="disabled"
          @click="emit('update', item.value)">{{ item.label }}</button>
      </div>
    </details>
    <p v-if="cronText.trim() && cronSize !== 5 && cronSize !== 6" role="status">请输入 5 段或 6 段 Cron 表达式。</p>
    <p v-else-if="cronDescription" role="status">{{ cronDescription }}</p>
  </div>
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
        {{ label(item) }}
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
  <details v-if="contact && auth?.().kind === 'session'" class="contact-lookup">
    <summary>查找{{ contactTitle }}</summary>
    <div class="inline-field">
      <input v-model="query" :aria-label="`搜索${contactTitle}`" placeholder="名称或号码" maxlength="80"
        :disabled="disabled" @keydown.enter.prevent.stop="searchContacts(1)" />
      <button type="button" :disabled="disabled || searching" @click="searchContacts(1)">查找</button>
    </div>
    <p v-if="contactMessage" role="status">{{ contactMessage }}</p>
    <ul v-if="matches.length" class="contact-results" :aria-label="`${contactTitle}查询结果`">
      <li v-for="item in matches" :key="item.id">
        <button type="button" :disabled="disabled || searching" @click="pickContact(item)">
          {{ item.name ? `${item.name}（${item.id}）` : item.id }}
        </button>
      </li>
    </ul>
    <div v-if="page > 1 || nextPage" class="inline-field">
      <button type="button" :disabled="disabled || searching || page < 2" @click="searchContacts(page - 1)">上一页</button>
      <button type="button" :disabled="disabled || searching || !nextPage" @click="searchContacts(page + 1)">下一页</button>
    </div>
  </details>
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
.contact-lookup > summary { color: var(--accent); cursor: pointer; margin-bottom: 6px; }
.contact-lookup p { margin: 4px 0; }
.contact-results { display: flex; flex-wrap: wrap; list-style: none; gap: 6px; margin: 8px 0; padding: 0; }
.cron-field { display: grid; gap: 6px; }
.cron-field p { margin: 0; }
.cron-presets { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
</style>
