<script setup lang="ts">
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

const switches = [{ label: "关闭", value: 0 }, { label: "开启", value: 1 }];
const dispatch: readonly Field[] = [
  { key: "groupCD", label: "群聊冷却（毫秒）", type: "number", max: 2_147_483_647, hint: "填 0 关闭冷却。" },
  { key: "singleCD", label: "群成员冷却（毫秒）", type: "number", max: 2_147_483_647, hint: "填 0 关闭冷却。" },
  { key: "onlyReplyAt", label: "处理群消息的条件", type: "choices", choices: [
    { label: "无需提及", value: 0 },
    { label: "仅在 @ 机器人或使用别名时回复", value: 1 },
    { label: "仅在 @ 机器人或使用别名时回复，主人例外", value: 2 },
  ] },
  { key: "botAlias", label: "机器人别名", type: "list", hint: "每行一个别名。列表留空时没有别名。" },
  { key: "enable", label: "仅启用指定功能", type: "list", hint: "每行一个功能名。列表留空时不限功能。" },
  { key: "disable", label: "禁用指定功能", type: "list", hint: "每行一个功能名。列表留空时无禁用项。" },
];
const keywords: readonly Field[] = [
  { key: "addLimit", label: "群词条编辑权限", type: "choices", choices: [
    { label: "不限制", value: 0 }, { label: "仅管理员、群主和主人", value: 1 }, { label: "仅主人", value: 2 },
  ] },
  { key: "addPrivate", label: "允许私聊管理群词条", type: "choices", choices: switches },
  { key: "addReply", label: "发送词条时引用原消息", type: "choices", choices: switches },
  { key: "addAt", label: "发送词条时 @ 发言人", type: "choices", choices: switches },
  { key: "addRecall", label: "词条回复撤回延时（秒）", type: "number", max: 2_147_483_647,
    hint: "填 0 不撤回，实际延时最长 120 秒。" },
];

function scopeLabel(key: string) {
  if (key === "default") return "全局默认";
  const [first, second] = key.split(":");
  if (!second) return `群 ${first}`;
  return second === "default" ? `机器人 ${first} 的默认设置` : `机器人 ${first} · 群 ${second}`;
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
      <label for="group-routing-scope">编辑范围</label>
      <select id="group-routing-scope" v-model="scope" :disabled="disabled">
        <option v-for="key in scopes" :key="key" :value="key">{{ scopeLabel(key) }}</option>
      </select>
      <span class="routing-hint">生效顺序由低到高为全局默认、机器人默认、群、机器人与群。</span>
      <span v-if="legacy && scope === 'default'" class="routing-hint">旧配置有全局默认范围时，会用这个范围替代原有的内置默认项。</span>
      <span v-if="current === null" class="routing-hint">此范围在配置文件中为空值。</span>
      <span v-else-if="current && Object.keys(current).length === 0" class="routing-hint">此范围没有在面板中可见的覆盖项。</span>
    </div>
    <details>
      <summary>指定其他范围</summary>
      <div class="routing-scope-inputs">
        <label>范围类型
          <select v-model="scopeKind" :disabled="disabled">
            <option value="group">群</option>
            <option value="bot">机器人默认</option>
            <option value="bot-group">机器人与群</option>
          </select>
        </label>
        <label v-if="scopeKind !== 'group'">机器人 QQ 号
          <input v-model="botId" inputmode="numeric" :disabled="disabled">
        </label>
        <label v-if="scopeKind !== 'bot'">群号
          <input v-model="groupId" inputmode="numeric" :disabled="disabled">
        </label>
        <ElButton :disabled="disabled || !newScope" @click="scope = newScope">编辑此范围</ElButton>
      </div>
    </details>
    <fieldset v-for="section in [{ label: '消息处理', fields: dispatch }, { label: '关键词', fields: keywords }]"
      :key="section.label" :disabled="disabled">
      <legend>{{ section.label }}</legend>
      <div v-for="field in section.fields" :key="field.key" class="routing-field">
        <label :for="'routing-mode-' + field.key">{{ field.label }}</label>
        <select :id="'routing-mode-' + field.key" :value="mode(field)" @change="setMode(field, $event)">
          <option value="inherit">{{ legacy && scope === 'default' ? '此处不配置' : '继承' }}</option>
          <option v-for="choice in field.choices" :key="choice.value" :value="String(choice.value)">{{ choice.label }}</option>
          <option v-if="field.type !== 'choices'" value="value">自定义{{ field.type === 'list' ? '列表' : '' }}</option>
          <option value="null">空值（覆盖上一级）</option>
        </select>
        <input v-if="field.type === 'number' && mode(field) === 'value'" type="number" min="0" step="1" required
          :max="field.max" :aria-label="field.label + '数值'" :value="current?.[field.key] as string | number"
          @input="setNumber(field.key, $event)">
        <textarea v-if="field.type === 'list' && mode(field) === 'value'" rows="3"
          :aria-label="field.label + '列表'" :value="listText(field.key)" @input="setList(field.key, $event)" />
        <span v-if="field.hint" class="routing-hint">{{ field.hint }}</span>
      </div>
    </fieldset>
    <div>
      <ElButton :disabled="disabled || current === undefined" @click="clearScope">移除此范围的覆盖</ElButton>
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
