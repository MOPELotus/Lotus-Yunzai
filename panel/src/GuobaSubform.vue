<script setup lang="ts">
import { ElButton } from "element-plus";
import { computed, ref, shallowRef, watch } from "vue";
import type { GuobaField, GuobaInput, GuobaSubformEdit, GuobaSubformSnapshot } from "../../lib/panel-guoba.ts";

type Row = GuobaSubformEdit["rows"][number];
type Field = GuobaField & { field: string };
const props = defineProps<{ id: string; schema: GuobaField; saved: GuobaSubformSnapshot; edited?: GuobaSubformEdit }>();
const emit = defineEmits<{ update: [value: GuobaSubformEdit | undefined] }>();
const editor = ref<HTMLElement>();
const position = ref<number | null>(null);
const draft = shallowRef<Record<string, GuobaInput>>({});
const pendingRemove = ref<number>();
const error = ref("");
const single = computed(() => props.schema.componentProps?.multiple === false);
const dialog = () => editor.value instanceof HTMLDialogElement ? editor.value : undefined;
const heading = computed(() => props.schema.componentProps?.title ?? props.schema.label);
const fields = computed(() => (props.schema.componentProps?.schemas ?? []).filter((item): item is Field => item.field !== undefined));
const summaries = computed(() => fields.value.filter(item => item.component !== "InputPassword").slice(0, 3));
const rows = computed<readonly Row[]>(() => props.edited?.rows ?? props.saved.rows.map((_, index) => ({ index, values: {} })));
const target = computed(() => single.value ? rows.value[0] : position.value === null ? undefined : rows.value[position.value]);
const stored = computed(() => target.value?.index == null ? undefined : props.saved.rows[target.value.index]);
const limits = computed(() => props.schema.componentProps ?? {});
const fieldEdits = computed(() => single.value ? props.edited?.rows[0]?.values ?? {} : draft.value);
function savedValue(field: string) {
  const current = stored.value?.values[field];
  return current === undefined && single.value
    ? fields.value.find(item => item.field === field)?.componentProps?.defaultValue : current;
}
const value = (field: string) => Object.hasOwn(fieldEdits.value, field) ? fieldEdits.value[field] : savedValue(field);
const required = (item: Field) => single.value && Boolean(props.edited) && item.required;

function updateEdits(edits: Record<string, GuobaInput>) {
  if (single.value) {
    emit("update", Object.keys(edits).length ? {
      revision: props.saved.revision, rows: [{ index: target.value?.index ?? null, values: edits }],
    } : undefined);
  } else {
    draft.value = edits;
  }
}

watch(() => props.saved.revision, () => {
  pendingRemove.value = undefined;
  if (dialog()?.open) dialog()?.close();
});

function open(index: number | null) {
  const row = index === null ? undefined : rows.value[index];
  position.value = index;
  draft.value = row ? { ...row.values } : Object.fromEntries(fields.value
    .filter(item => item.componentProps?.defaultValue !== undefined)
    .map(item => [item.field, item.componentProps!.defaultValue!]));
  error.value = "";
  dialog()?.showModal();
}

function edit(field: string, next: GuobaInput) {
  const before = savedValue(field);
  const same = Array.isArray(before) && Array.isArray(next)
    ? before.length === next.length && before.every((item, index) => item === next[index]) : before === next;
  const edits = { ...fieldEdits.value };
  if (same) delete edits[field];
  else edits[field] = next;
  updateEdits(edits);
  error.value = "";
}

function password(field: string, event: Event) {
  const next = text(event);
  if (next) edit(field, next);
  else {
    keepPassword(field);
  }
}

function keepPassword(field: string) {
  const edits = { ...fieldEdits.value };
  delete edits[field];
  updateEdits(edits);
}

function preventOuterSubmit(event: KeyboardEvent) {
  if (!single.value && event.target instanceof HTMLInputElement && event.target.type !== "checkbox") event.preventDefault();
}

function text(event: Event) {
  return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
}

function updateNumber(field: string, event: Event) {
  const control = event.target as HTMLInputElement;
  if (!control.validity.badInput) edit(field, Number.isFinite(control.valueAsNumber) ? control.valueAsNumber : null);
}

function tags(item: Field, event: Event) {
  const current = value(item.field);
  const candidates = [...(Array.isArray(current) ? current : []), ...(item.componentProps?.options ?? []).map(entry => entry.value)];
  edit(item.field, text(event).split(/\r?\n/u).filter(entry => entry.trim()).map(entry => {
    const original = candidates.findIndex(candidate => String(candidate) === entry);
    return original < 0 ? entry : candidates[original]!;
  }));
}

function addTag(item: Field, option: Exclude<GuobaInput, unknown[]>) {
  const current = value(item.field);
  const entries = Array.isArray(current) ? current : [];
  if (!entries.includes(option)) edit(item.field, [...entries, option]);
}

function select(item: Field, event: Event) {
  const control = event.target as HTMLSelectElement;
  const options = item.componentProps?.options ?? [];
  const values = Array.from(control.selectedOptions).flatMap(option =>
    option.value !== "" && options[Number(option.value)] ? [options[Number(option.value)]!.value] : []);
  edit(item.field, control.multiple ? values : values[0] ?? null);
}

function display(input: GuobaInput | undefined, separator = "\n") {
  return Array.isArray(input) ? input.map(String).join(separator) : input == null ? "" : String(input);
}

function rowText(row: Row, field: Field) {
  const input = Object.hasOwn(row.values, field.field) ? row.values[field.field] :
    row.index === null ? undefined : props.saved.rows[row.index]?.values[field.field];
  if (typeof input === "boolean") return input ? "是" : "否";
  return field.componentProps?.options?.find(option => option.value === input)?.label ?? (display(input, "、") || "—");
}

function selected(item: Field, option: Exclude<GuobaInput, unknown[]>) {
  const current = value(item.field);
  return Array.isArray(current) ? current.includes(option) : current === option;
}

function publish(next: readonly Row[]) {
  const unchanged = next.length === props.saved.rows.length &&
    next.every((row, index) => row.index === index && Object.keys(row.values).length === 0);
  emit("update", unchanged ? undefined : { revision: props.saved.revision, rows: next });
}

function confirm() {
  for (const item of fields.value) {
    const input = value(item.field);
    const hasPassword = item.component === "InputPassword" && !Object.hasOwn(draft.value, item.field) &&
      stored.value?.configuredPasswords.includes(item.field);
    if (item.required && !hasPassword && (input == null || input === "" || (Array.isArray(input) && !input.length))) {
      error.value = `请填写「${item.label}」。`;
      return;
    }
  }
  const invalid = editor.value?.querySelector<HTMLInputElement>("input:invalid");
  if (invalid) {
    invalid.reportValidity();
    return;
  }
  const row = { index: target.value?.index ?? null, values: draft.value };
  publish(position.value === null ? [...rows.value, row] : rows.value.map((old, index) => index === position.value ? row : old));
  dialog()?.close();
}
</script>

<template>
  <section class="subform" :aria-labelledby="`${id}-title`">
    <h3 :id="`${id}-title`">{{ schema.label }}</h3>
    <p v-if="schema.bottomHelpMessage" class="subform-help">{{ schema.bottomHelpMessage }}</p>
    <template v-if="!single">
      <p v-if="!rows.length" class="subform-help">暂无数据</p>
      <ul v-else class="subform-rows">
        <li v-for="(row, index) in rows" :key="row.index ?? `new-${index}`">
          <dl>
            <div v-for="field in summaries" :key="field.field">
              <dt>{{ field.label }}</dt><dd>{{ rowText(row, field) }}</dd>
            </div>
          </dl>
          <div class="subform-actions">
            <ElButton :aria-label="`编辑第 ${index + 1} 条`" @click="open(index)">编辑</ElButton>
            <template v-if="pendingRemove === index">
              <ElButton @click="pendingRemove = undefined">取消</ElButton>
              <ElButton type="danger" @click="publish(rows.filter((_, at) => at !== index)); pendingRemove = undefined">
                确认删除
              </ElButton>
            </template>
            <ElButton v-else :disabled="rows.length <= (limits.lengthMin ?? 0)"
              :aria-label="`删除第 ${index + 1} 条`" @click="pendingRemove = index">删除</ElButton>
          </div>
        </li>
      </ul>
      <ElButton :disabled="limits.lengthMax !== undefined && rows.length >= limits.lengthMax" @click="open(null)">新增</ElButton>
    </template>

    <component :is="single ? 'div' : 'dialog'" ref="editor" :class="{ 'subform-editor': !single }"
      :aria-labelledby="single ? undefined : `${id}-editor-title`"
      @keydown.enter="preventOuterSubmit">
      <h3 v-if="!single" :id="`${id}-editor-title`">{{ position === null ? "新增" : "编辑" }}{{ heading }}</h3>
      <div class="subform-editor-fields">
        <div v-for="(item, index) in fields" :key="item.field" class="subform-field">
          <label :for="`${id}-child-${index}`">{{ item.label }}<template v-if="item.required">（必填）</template></label>
          <template v-if="item.component === 'InputPassword'">
            <input :id="`${id}-child-${index}`" type="password" autocomplete="new-password"
              :value="display(fieldEdits[item.field])" :disabled="fieldEdits[item.field] === null" placeholder="留空保留现有密码"
                :required="required(item) && !stored?.configuredPasswords.includes(item.field)"
              @input="password(item.field, $event)" />
            <ElButton v-if="fieldEdits[item.field] === null" @click="keepPassword(item.field)">撤销清除</ElButton>
            <ElButton v-else-if="stored?.configuredPasswords.includes(item.field)" @click="edit(item.field, null)">清除密码</ElButton>
          </template>
          <input v-else-if="item.component === 'Switch'" :id="`${id}-child-${index}`" type="checkbox"
            :checked="value(item.field) === true" @change="edit(item.field, ($event.target as HTMLInputElement).checked)" />
          <div v-else-if="item.component === 'InputNumber'" class="subform-number">
            <input :id="`${id}-child-${index}`" type="number" :value="display(value(item.field))"
              :min="item.componentProps?.min" :max="item.componentProps?.max" :step="item.componentProps?.step ?? 'any'"
              :placeholder="item.componentProps?.placeholder" :required="required(item)" @input="updateNumber(item.field, $event)" />
            <span v-if="item.componentProps?.addonAfter">{{ item.componentProps.addonAfter }}</span>
          </div>
          <template v-else-if="item.component === 'Select' && item.componentProps?.mode === 'tags'">
            <textarea :id="`${id}-child-${index}`" :value="display(value(item.field))"
              rows="3" placeholder="每行一个标签" :required="required(item)" @change="tags(item, $event)" />
            <div v-if="item.componentProps.options?.length" class="subform-actions" role="group"
              :aria-label="`${item.label}预设`">
              <ElButton v-for="(option, at) in item.componentProps.options" :key="at" size="small"
                :disabled="option.disabled || selected(item, option.value)" @click="addTag(item, option.value)">
                添加 {{ option.label }}
              </ElButton>
            </div>
          </template>
          <select v-else-if="item.component === 'Select'" :id="`${id}-child-${index}`"
            :multiple="item.componentProps?.mode === 'multiple'" :required="required(item)" @change="select(item, $event)">
            <option v-if="item.componentProps?.mode !== 'multiple'" value="" disabled
              :selected="!item.componentProps?.options?.some(option => selected(item, option.value))">请选择</option>
            <option v-for="(option, at) in item.componentProps?.options" :key="at" :value="at"
              :disabled="option.disabled" :selected="selected(item, option.value)">{{ option.label }}</option>
          </select>
          <textarea v-else-if="item.component === 'InputTextArea'" :id="`${id}-child-${index}`"
            :value="display(value(item.field))" :rows="item.componentProps?.rows ?? 3"
            :placeholder="item.componentProps?.placeholder" :required="required(item)" @input="edit(item.field, text($event))" />
          <input v-else :id="`${id}-child-${index}`" :value="display(value(item.field))"
            :placeholder="item.componentProps?.placeholder" :required="required(item)" @input="edit(item.field, text($event))" />
          <p v-if="item.bottomHelpMessage" class="subform-help">{{ item.bottomHelpMessage }}</p>
        </div>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div v-if="!single" class="subform-actions">
        <ElButton @click="dialog()?.close()">取消</ElButton>
        <ElButton type="primary" @click="confirm">确定</ElButton>
      </div>
    </component>
  </section>
</template>

<style scoped>
.subform { min-width: 0; grid-column: 1 / -1; }
.subform h3, .subform-editor h3 { font-size: 15px; margin: 0 0 8px; }
.subform-help { color: var(--muted); font-size: 13px; margin: 6px 0; overflow-wrap: anywhere; }
.subform-rows { list-style: none; padding: 0; margin: 9px 0; display: grid; gap: 7px; }
.subform-rows li {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between;
  padding: 8px; border: 1px solid var(--line); border-radius: 7px;
}
.subform-rows dl { margin: 0; display: flex; flex-wrap: wrap; gap: 8px 18px; }
.subform-rows dt, .subform-rows dd { overflow-wrap: anywhere; font-size: 13px; }
.subform-rows dt { color: var(--muted); }
.subform-rows dd { margin: 3px 0 0; }
.subform-actions, .subform-number { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.subform-actions :deep(.el-button + .el-button) { margin-left: 0; }
.subform-editor {
  width: min(560px, calc(100% - 28px)); max-height: min(700px, calc(100% - 24px));
  color: var(--ink); background: var(--surface); border: 1px solid var(--line);
  padding: 16px; border-radius: 12px;
}
.subform-editor::backdrop { background: #12211d66; }
.subform-editor[open] { display: flex; flex-direction: column; overflow: hidden; }
.subform-editor-fields { overflow: auto; padding: 0 2px 2px; }
.subform-editor > .subform-actions { justify-content: flex-end; margin-top: 12px; }
.subform-field { display: grid; gap: 4px; margin-top: 10px; }
.subform-field label { font-weight: 600; font-size: 14px; }
.subform-field input[type="checkbox"] { justify-self: start; margin: 3px 0; accent-color: var(--accent); }
.subform-field input:not([type="checkbox"]), .subform-field select, .subform-field textarea {
  width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 7px;
  background: var(--surface); color: var(--ink); font: inherit;
}
.subform-number { flex-wrap: nowrap; }
.subform-number input { min-width: 0; }
.subform-number span { white-space: nowrap; }
</style>
