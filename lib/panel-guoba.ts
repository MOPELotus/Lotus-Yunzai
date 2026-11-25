import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createHmac, randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { guobaActions, resolveGuobaArguments } from "./panel-guoba-actions.ts";

const components = [
  "Divider", "Input", "InputPassword", "InputTextArea", "InputNumber", "Switch", "Select", "EasyCron", "GSubForm",
  "CheckboxGroup", "GTags", "GSelectGroup", "GSelectFriend", "GColorPicker", "DatePicker", "TimePicker", "TreeSelect",
  "Slider", "Rate", "AutoComplete", "Cascader",
] as const;
type Component = typeof components[number] | "GButtons";
type Scalar = string | number | boolean | null;
export type GuobaPath = (string | number)[];
export type GuobaInput = Scalar | (Scalar | GuobaPath)[];

export interface GuobaTreeNode {
  readonly label: string;
  readonly value: string | number;
  readonly disabled?: boolean;
  readonly children?: readonly GuobaTreeNode[];
}

export interface GuobaSubformRow {
  readonly values: Readonly<Record<string, GuobaInput>>;
  readonly configuredPasswords: readonly string[];
  readonly subforms?: Readonly<Record<string, GuobaSubformSnapshot>>;
}

export interface GuobaSubformSnapshot {
  readonly revision: string;
  readonly rows: readonly GuobaSubformRow[];
  readonly emptySubforms?: Readonly<Record<string, GuobaSubformSnapshot>>;
}

export interface GuobaSubformEdit {
  readonly revision: string;
  readonly rows: readonly { index: number | null; values: Record<string, GuobaEdit> }[];
}

export type GuobaEdit = GuobaInput | GuobaSubformEdit;

export interface GuobaButton {
  readonly id: string;
  readonly label: string;
  readonly fields: readonly string[];
  readonly confirm?: string;
  readonly disabled?: true;
  readonly type?: "primary" | "danger";
}

export interface GuobaField {
  readonly component: Component;
  readonly field?: string;
  readonly label: string;
  readonly bottomHelpMessage?: string;
  readonly required?: true;
  readonly componentProps?: Readonly<{
    placeholder?: string;
    rows?: number;
    min?: number;
    max?: number;
    step?: number;
    mode?: "multiple" | "tags";
    options?: readonly { label: string; value: Scalar; disabled?: boolean }[];
    defaultValue?: GuobaInput;
    addonAfter?: string;
    schemas?: readonly GuobaField[];
    title?: string;
    multiple?: boolean;
    lengthMin?: number;
    lengthMax?: number;
    buttons?: readonly GuobaButton[];
    numeric?: boolean;
    allowAdd?: boolean;
    allowDel?: boolean;
    single?: boolean;
    format?: string;
    valueFormat?: string;
    dateType?: "date" | "datetime" | "week" | "month" | "year";
    treeData?: readonly GuobaTreeNode[];
    treeCheckable?: boolean;
    treeCheckStrictly?: boolean;
    labelInValue?: boolean;
    allowHalf?: boolean;
    count?: number;
    marks?: Readonly<Record<number, string>>;
    marksOnly?: boolean;
    changeOnSelect?: boolean;
  }>;
}

interface GuobaValues {
  values: Record<string, GuobaInput>;
  configuredPasswords: string[];
  subforms?: Record<string, GuobaSubformSnapshot>;
  actionRevision?: string;
}

interface GuobaResult {
  ok: boolean;
  status: number;
  message: string;
}

interface GuobaSaveGuard {
  verify(): boolean;
  registered(): boolean;
  readonly signal: AbortSignal;
}

export interface GuobaForm {
  readonly schemas: readonly GuobaField[];
  readonly writable: boolean;
  read(): Promise<GuobaValues>;
  save(data: unknown, guard?: GuobaSaveGuard): Promise<GuobaResult>;
  action(data: unknown, verify: () => boolean, registered: () => boolean, signal: AbortSignal): Promise<GuobaResult>;
}

type ValueField = GuobaField & { readonly field: string };
interface PathNode {
  children: Map<string, PathNode>;
  field?: ValueField;
}

const deniedKeys = new Set(["__proto__", "constructor", "prototype"]);
const writeQueues = new Map<string, Promise<GuobaResult>>();
const providerVersions = new Map<string, string>();
const subformSecret = randomBytes(32);

class SubformConflict extends Error {}
class SubformInputError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): value is Scalar {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

function isGuobaPath(value: unknown): value is GuobaPath {
  return Array.isArray(value) && value.length > 0 &&
    value.every(item => typeof item === "string" || (typeof item === "number" && Number.isFinite(item)));
}

function pathParts(field: string): string[] {
  const match = /^([^.[\]]+)((?:\.[^.[\]]+|\[(?:"[^"]+"|'[^']+'|\d+)\])*)$/u.exec(field);
  if (!match?.[1]) throw new Error();
  const parts = [match[1]];
  for (const part of (match[2] ?? "").matchAll(/\.([^.[\]]+)|\["([^"]+)"\]|\['([^']+)'\]|\[(\d+)\]/gu)) {
    const key = part[1] ?? part[2] ?? part[3] ?? part[4];
    if (key !== undefined) parts.push(key);
  }
  if (parts.some((key) => deniedKeys.has(key))) throw new Error();
  return parts;
}

function getValue(values: Record<string, unknown>, field: string, parts: readonly string[]): unknown {
  if (Object.hasOwn(values, field)) return values[field];
  let value: unknown = values;
  for (const key of parts) {
    if ((!record(value) && !Array.isArray(value)) || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function normaliseTree(input: unknown, fields: Record<string, unknown>, uniqueTree = true): GuobaTreeNode[] {
  if (!Array.isArray(input)) return [];
  const key = (name: string, fallback: string) => typeof fields[name] === "string" && !deniedKeys.has(fields[name])
    ? fields[name] : fallback;
  const valueKey = key("value", "value");
  const labelKey = key("label", key("title", "title"));
  const childrenKey = key("children", "children");
  const treeKeys = new Set<string | number>();
  function visit(nodes: unknown[], ancestors: ReadonlySet<object>): GuobaTreeNode[] {
    const seen = uniqueTree ? treeKeys : new Set<string | number>();
    return nodes.flatMap(node => {
      if (!record(node) || ancestors.has(node)) return [];
      const value = node[valueKey];
      if ((typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) || seen.has(value)) return [];
      seen.add(value);
      const label = node[labelKey] ?? node.label;
      const children = node[childrenKey];
      return [{
        label: typeof label === "string" ? label : String(value),
        value,
        ...(node.disabled === true || node.selectable === false ? { disabled: true } : {}),
        ...(Array.isArray(children) && children.length ? { children: visit(children, new Set([...ancestors, node])) } : {}),
      }];
    });
  }
  return visit(input, new Set());
}

function normaliseField(schema: unknown, ancestors: readonly unknown[] = []): GuobaField | undefined {
  if (!record(schema)) throw new Error();
  const child = ancestors.length > 0;
  const group = schema.component === "SOFT_GROUP_BEGIN";
  const aliases: Record<string, Component> = { Textarea: "InputTextArea", Checkbox: "Switch", RadioGroup: "Select" };
  const rawComponent = typeof schema.component === "string" && Object.hasOwn(aliases, schema.component)
    ? aliases[schema.component] : schema.component;
  const component = group ? "Divider" : components.find((name) => name === rawComponent);
  if (!component) return undefined;
  const { field, label, bottomHelpMessage } = schema;
  if (group && (label === undefined || label === null || label === "")) return undefined;
  if (typeof label !== "string") throw new Error();
  if (component === "Divider") return { component, label };
  if (typeof field !== "string" || !field) throw new Error();
  if (child && pathParts(field).length !== 1) return undefined;

  type ComponentProps = NonNullable<GuobaField["componentProps"]>;
  const props: { -readonly [Key in keyof ComponentProps]: ComponentProps[Key] } = {};
  if (component === "GSubForm") {
    const raw = schema.componentProps;
    if (ancestors.includes(schema) || !record(raw) || !Array.isArray(raw.schemas) ||
        (raw.multiple !== undefined && typeof raw.multiple !== "boolean")) return undefined;
    props.multiple = raw.multiple === true;
    props.schemas = raw.schemas.map(item => normaliseField(item, [...ancestors, schema])).filter(item => item !== undefined);
    if (!props.schemas.some(item => item.field !== undefined)) return undefined;
    compile(props.schemas);
    if (record(raw.modalProps) && typeof raw.modalProps.title === "string") props.title = raw.modalProps.title;
    if (props.multiple) {
      for (const key of ["lengthMin", "lengthMax"] as const) {
        const value = raw[key];
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) props[key] = value;
      }
    }
  } else if (component !== "InputPassword" && record(schema.componentProps)) {
    const raw = schema.componentProps;
    const { placeholder, rows, min, max, step, options, mode, defaultValue, addonAfter } = raw;
    if (component === "TreeSelect") {
      props.treeCheckStrictly = raw.treeCheckStrictly === true;
      props.treeCheckable = raw.treeCheckable === true || props.treeCheckStrictly;
      props.multiple = raw.multiple === true || props.treeCheckable;
      props.labelInValue = raw.labelInValue === true || props.treeCheckStrictly;
      props.treeData = normaliseTree(raw.treeData, record(raw.fieldNames) ? raw.fieldNames : {});
    }
    if (component === "Cascader") {
      props.multiple = raw.multiple === true;
      props.changeOnSelect = raw.changeOnSelect === true;
      props.treeData = normaliseTree(options, record(raw.fieldNames) ? raw.fieldNames : {}, false);
    }
    if (component === "Slider") {
      props.multiple = raw.range === true;
      props.marksOnly = raw.step === null;
      const minimum = typeof min === "number" && Number.isFinite(min) ? min : 0;
      const maximum = typeof max === "number" && Number.isFinite(max) ? max : 100;
      if (record(raw.marks)) {
        props.marks = Object.fromEntries(Object.entries(raw.marks).flatMap(([key, rawLabel]) => {
          const number = Number(key);
          if (!Number.isFinite(number) || number < minimum || number > maximum || !key.trim()) return [];
          const label = record(rawLabel) ? rawLabel.label : rawLabel;
          return [[number, typeof label === "string" || typeof label === "number" ? String(label) : key]];
        }));
      }
      if (props.marksOnly && !Object.keys(props.marks ?? {}).length) return undefined;
    }
    if (component === "Rate") {
      props.count = typeof raw.count === "number" && Number.isSafeInteger(raw.count) && raw.count >= 1 && raw.count <= 50 ? raw.count : 5;
      props.allowHalf = raw.allowHalf === true;
    }
    if (component === "GTags") {
      props.numeric = raw.numeric === true;
      props.allowAdd = raw.allowAdd !== false;
      props.allowDel = raw.allowDel !== false;
    }
    if (component === "GSelectGroup" || component === "GSelectFriend") props.single = raw.single === true;
    if (component === "DatePicker" || component === "TimePicker") {
      if (typeof raw.format === "string" && raw.format.length <= 80) props.format = raw.format;
      if (typeof raw.valueFormat === "string" && raw.valueFormat.length <= 80) props.valueFormat = raw.valueFormat;
      if (component === "DatePicker") {
        props.dateType = raw.showTime ? "datetime" : raw.picker === "week" || raw.picker === "month" || raw.picker === "year"
          ? raw.picker : "date";
      }
    }
    if (typeof placeholder === "string") props.placeholder = placeholder;
    if (typeof rows === "number" && Number.isSafeInteger(rows) && rows > 0) props.rows = rows;
    if (typeof min === "number" && Number.isFinite(min)) props.min = min;
    if (typeof max === "number" && Number.isFinite(max)) props.max = max;
    if (typeof step === "number" && Number.isFinite(step) && step > 0) props.step = step;
    if (mode === "multiple" || mode === "tags") props.mode = mode;
    if (component === "CheckboxGroup") props.mode = "multiple";
    if (child && typeof addonAfter === "string") props.addonAfter = addonAfter;
    if (child && (scalar(defaultValue) || (Array.isArray(defaultValue) && defaultValue.every(scalar)) ||
        (component === "Cascader" && props.multiple && Array.isArray(defaultValue) && defaultValue.every(isGuobaPath)))) {
      props.defaultValue = defaultValue;
    }
    if (component !== "Cascader" && Array.isArray(options)) {
      props.options = options.flatMap((option: unknown) => {
        if (typeof option === "string" || (typeof option === "number" && Number.isFinite(option))) {
          return [{ label: String(option), value: option }];
        }
        if (!record(option) || !scalar(option.value)) return [];
        const { label: optionLabel, value, disabled } = option;
        return [{ label: typeof optionLabel === "string" ? optionLabel : String(value), value,
          ...(typeof disabled === "boolean" ? { disabled } : {}) }];
      });
    }
  }
  if (child && component !== "InputPassword" &&
      (scalar(schema.defaultValue) || (Array.isArray(schema.defaultValue) && schema.defaultValue.every(scalar)) ||
        (component === "Cascader" && props.multiple && Array.isArray(schema.defaultValue) && schema.defaultValue.every(isGuobaPath)))) {
    props.defaultValue = schema.defaultValue;
  }
  return {
    component, field, label,
    ...(child && schema.required === true ? { required: true as const } : {}),
    ...(typeof bottomHelpMessage === "string" ? { bottomHelpMessage } : {}),
    ...(Object.keys(props).length ? { componentProps: props } : {}),
  };
}

function compile(schemas: readonly GuobaField[]) {
  const root: PathNode = { children: new Map() };
  const fields = new Map<string, { schema: ValueField; parts: readonly string[] }>();
  for (const schema of schemas) {
    if (schema.field === undefined) continue;
    const valueField = { ...schema, field: schema.field };
    const parts = pathParts(schema.field);
    let node = root;
    for (const part of parts) {
      if (node.field) throw new Error();
      const next = node.children.get(part) ?? { children: new Map<string, PathNode>() };
      node.children.set(part, next);
      node = next;
    }
    if (node.field || node.children.size) throw new Error();
    node.field = valueField;
    fields.set(schema.field, { schema: valueField, parts });
  }
  return { root, fields };
}

function inputValue(schema: ValueField, value: unknown): GuobaInput {
  if (value === null || typeof value === "string") return value;
  if (schema.component !== "InputPassword") {
    if (scalar(value)) return value;
    if (Array.isArray(value) && value.every(scalar)) return [...value];
    if (schema.component === "Cascader" && schema.componentProps?.multiple && Array.isArray(value) && value.every(isGuobaPath)) return value;
  }
  throw new Error();
}

function labeledTree(schema: GuobaField) {
  return schema.component === "TreeSelect" && schema.componentProps?.labelInValue === true;
}

function displayValue(schema: ValueField, value: unknown): GuobaInput {
  if (!labeledTree(schema) || value == null) return inputValue(schema, value);
  const raw = (item: unknown) => record(item) ? item.value : item;
  const display = Array.isArray(value) ? value.filter(item => !record(item) || item.halfChecked !== true).map(raw) : raw(value);
  return inputValue(schema, display);
}

function treeNode(nodes: readonly GuobaTreeNode[], item: Scalar): GuobaTreeNode | undefined {
  for (const node of nodes) {
    if (node.value === item) return node;
    const child = node.children && treeNode(node.children, item);
    if (child) return child;
  }
}

function validCascaderPath(nodes: readonly GuobaTreeNode[], selection: GuobaPath, acceptsParents: boolean) {
  for (const value of selection) {
    const current = nodes.find(node => !node.disabled && node.value === value);
    if (!current) return false;
    nodes = current.children ?? [];
  }
  return acceptsParents || nodes.length === 0;
}

function storedValue(schema: GuobaField, value: GuobaInput, previous: unknown): unknown {
  if (!labeledTree(schema) || value === null) return value;
  const { treeData = [], treeCheckStrictly } = schema.componentProps!;
  const old = (Array.isArray(previous) ? previous : [previous]).filter(record);
  const item = (key: Scalar | GuobaPath) => {
    const carried = old.find(entry => entry.value === key && entry.halfChecked !== true);
    return carried ?? { value: key, label: (scalar(key) && treeNode(treeData, key)?.label) || String(key) };
  };
  if (!Array.isArray(value)) return item(value);
  const halfChecked = treeCheckStrictly ? old.filter(entry => entry.halfChecked === true && !value.includes(entry.value as Scalar)) : [];
  return [...value.map(item), ...halfChecked];
}

function submittedValue(schema: ValueField, raw: unknown): GuobaInput {
  const value = inputValue(schema, raw);
  if (value === null) return value;
  const { componentProps: props } = schema;
  if (schema.component === "GTags" && (!Array.isArray(value) || value.some(item =>
    !(typeof item === "string" || typeof item === "number") ||
    (Boolean(props?.options?.length) && !props?.options?.some(option => option.value === item && !option.disabled))))) {
    throw new Error();
  }
  if (schema.component === "GSelectGroup" || schema.component === "GSelectFriend") {
    const ids = Array.isArray(value) ? value : [value];
    if (Array.isArray(value) === Boolean(props?.single) || ids.some(id => typeof id === "number"
      ? !Number.isSafeInteger(id) || id < 1
      : typeof id !== "string" || !/^[1-9][0-9]*$/u.test(id))) throw new Error();
  }
  if (schema.component === "GColorPicker" && typeof value !== "string") throw new Error();
  if (schema.component === "AutoComplete" && typeof value !== "string") throw new Error();
  if (schema.component === "Slider") {
    const values = Array.isArray(value) ? value : [value];
    if (Array.isArray(value) !== Boolean(props?.multiple) || (Array.isArray(value) && (value.length !== 2 || Number(value[0]) > Number(value[1]))) ||
        values.some(item => typeof item !== "number" || item < (props?.min ?? 0) || item > (props?.max ?? 100) ||
          (props?.marksOnly && !Object.hasOwn(props.marks ?? {}, item)))) throw new Error();
  }
  if (schema.component === "Rate" && (typeof value !== "number" || value < 0 || value > (props?.count ?? 5) ||
      !Number.isInteger(value * (props?.allowHalf ? 2 : 1)))) throw new Error();
  if (schema.component === "Cascader") {
    if (!Array.isArray(value)) throw new Error();
    const paths = props?.multiple ? value : value.length ? [value] : [];
    if (!paths.every(path => isGuobaPath(path) && validCascaderPath(props?.treeData ?? [], path, props?.changeOnSelect === true))) throw new Error();
  }
  if ((schema.component === "DatePicker" || schema.component === "TimePicker") &&
      typeof value !== "string" && typeof value !== "number") throw new Error();
  if (schema.component === "TreeSelect") {
    const values = Array.isArray(value) ? value : [value];
    if (Array.isArray(value) !== Boolean(props?.multiple) ||
        values.some(item => {
          const node = scalar(item) ? treeNode(props?.treeData ?? [], item) : undefined;
          return !node || node.disabled;
        })) throw new Error();
  }
  if (schema.component === "InputNumber") {
    const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number) ||
        (props?.min !== undefined && number < props.min) || (props?.max !== undefined && number > props.max)) {
      throw new Error();
    }
  }
  if (schema.component === "CheckboxGroup" && !Array.isArray(value)) throw new Error();
  if ((schema.component === "Select" || schema.component === "CheckboxGroup") && props?.mode !== "tags") {
    const options = props?.options;
    const entries = Array.isArray(value) ? value : [value];
    if ((Array.isArray(value) && props?.mode !== "multiple") ||
        (options !== undefined && entries.some((entry) => !options.some((option) => option.value === entry)))) {
      throw new Error();
    }
  }
  return value;
}

function readRows(schema: ValueField, value: unknown): Record<string, unknown>[] {
  if (value == null) return [];
  if (schema.componentProps?.multiple === false) {
    if (!record(value)) throw new Error();
    return [value];
  }
  if (!Array.isArray(value) || !value.every(record)) throw new Error();
  return value;
}

function subformRevision(file: string, field: string, rows: readonly unknown[]): string {
  return createHmac("sha256", subformSecret).update(JSON.stringify([file, field, rows])).digest("hex");
}

function subformSnapshot(file: string, schema: ValueField, rows: readonly Record<string, unknown>[]): GuobaSubformSnapshot {
  const children = schema.componentProps?.schemas ?? [];
  const nested = children.filter((child): child is ValueField => child.component === "GSubForm" && child.field !== undefined);
  const emptySubforms = Object.fromEntries(nested.map(child => [child.field, subformSnapshot(file, child, [])]));
  return { revision: subformRevision(file, schema.field, rows), rows: rows.map(row => {
    const values: Record<string, GuobaInput> = Object.create(null);
    const configuredPasswords: string[] = [];
    for (const child of children) {
      if (!child.field || !Object.hasOwn(row, child.field)) continue;
      const value = row[child.field];
      if (child.component === "InputPassword") {
        if (typeof value === "string" && value.length) configuredPasswords.push(child.field);
      } else if (child.component !== "GSubForm" && value !== undefined) {
        values[child.field] = displayValue({ ...child, field: child.field }, value);
      }
    }
    const subforms = Object.fromEntries(nested.map(child =>
      [child.field, subformSnapshot(file, child, readRows(child, row[child.field]))]));
    return { values, configuredPasswords, ...(nested.length ? { subforms } : {}) };
  }), ...(nested.length ? { emptySubforms } : {}) };
}

function parseSubformEdit(schema: ValueField, input: unknown): GuobaSubformEdit {
  if (!record(input) || Object.keys(input).length !== 2 || typeof input.revision !== "string" ||
      !/^[0-9a-f]{64}$/u.test(input.revision) || !Array.isArray(input.rows)) throw new Error();
  const props = schema.componentProps;
  if ((props?.multiple === false && input.rows.length !== 1) ||
      (props?.lengthMin !== undefined && input.rows.length < props.lengthMin) ||
      (props?.lengthMax !== undefined && input.rows.length > props.lengthMax)) throw new Error();
  const children = compile(props?.schemas ?? []);
  const indexes = new Set<number>();
  const rows = input.rows.map((row: unknown) => {
    if (!record(row) || Object.keys(row).length !== 2 || !record(row.values)) throw new Error();
    const { index } = row;
    if (index !== null) {
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || indexes.has(index)) throw new Error();
      indexes.add(index);
    }
    const entries = Object.entries(row.values).map(([field, value]) => {
      const child = children.fields.get(field);
      if (!child) throw new Error();
      return [field, child.schema.component === "GSubForm"
        ? parseSubformEdit(child.schema, value) : submittedValue(child.schema, value)] as const;
    });
    return { index, values: Object.fromEntries(entries) };
  });
  return { revision: input.revision, rows };
}

function mergeSubform(file: string, schema: ValueField, current: readonly Record<string, unknown>[], edit: GuobaSubformEdit) {
  if (subformRevision(file, schema.field, current) !== edit.revision) throw new SubformConflict();
  const single = schema.componentProps?.multiple === false;
  const fields = schema.componentProps?.schemas ?? [];
  const rows = edit.rows.map(({ index, values }) => {
    const existing = index === null ? undefined : current[index];
    if ((index !== null && !existing) || (single && index === null && current.length !== 0)) {
      throw new SubformInputError();
    }
    const row = { ...existing };
    const changed = index === null || Object.keys(values).length > 0;
    for (const child of fields) {
      if (!child.field) continue;
      if (Object.hasOwn(values, child.field)) {
        const changedValue = values[child.field]!;
        row[child.field] = child.component === "GSubForm"
          ? mergeSubform(file, { ...child, field: child.field }, readRows({ ...child, field: child.field }, row[child.field]),
            changedValue as GuobaSubformEdit)
          : storedValue(child, changedValue as GuobaInput, row[child.field]);
      }
      if (single && changed && row[child.field] === undefined && child.componentProps?.defaultValue !== undefined) {
        row[child.field] = storedValue(child, child.componentProps.defaultValue, undefined);
      }
      if (child.component === "InputPassword" && row[child.field] === "") {
        row[child.field] = existing?.[child.field] ?? "";
      }
      const value = row[child.field];
      if (changed && child.required && (value == null || value === "" ||
          (Array.isArray(value) && value.length === 0))) throw new SubformInputError();
    }
    return row;
  });
  return single ? rows[0] : rows;
}

function submitted(data: unknown, compiled: ReturnType<typeof compile>): Record<string, GuobaEdit> {
  if (!record(data)) throw new Error();
  const nested = new Map<ValueField, unknown>();
  const explicit = new Map<ValueField, unknown>();

  function visit(node: PathNode | undefined, value: unknown): void {
    if (!node) throw new Error();
    if (node.field) {
      nested.set(node.field, value);
      return;
    }
    if (!record(value) && !Array.isArray(value)) throw new Error();
    for (const [name, item] of Object.entries(value)) visit(node.children.get(name), item);
  }

  for (const [name, value] of Object.entries(data)) {
    const field = compiled.fields.get(name);
    if (field) explicit.set(field.schema, value);
    else visit(compiled.root.children.get(name), value);
  }
  return Object.fromEntries([...new Map([...nested, ...explicit])]
    .map(([field, value]) => [field.field, field.component === "GSubForm"
      ? parseSubformEdit(field, value) : submittedValue(field, value)]));
}

class Result {
  private constructor(readonly code: number, readonly result: unknown, readonly message: unknown, readonly httpStatus = 200) {}

  get isOk(): boolean { return this.code === 0; }

  static ok(result: unknown, message: string = "ok"): Result {
    return new Result(0, result, message);
  }

  static error(...args: unknown[]): Result {
    const [first, second, third, fourth] = args;
    if (typeof first === "number") {
      return new Result(first, third ?? {}, second ?? "error", typeof fourth === "number" ? fourth : 200);
    }
    if (args.length === 2 && typeof second === "number") return new Result(-1, {}, first, second);
    return new Result(-1, second ?? {}, first, typeof third === "number" ? third : 200);
  }

  toJSON() { return { ok: this.isOk, code: this.code, result: this.result, message: this.message }; }
}

async function supportFile(pluginDirectory: string): Promise<string | undefined> {
  if (!isAbsolute(pluginDirectory)) throw new Error();
  const directory = await realpath(pluginDirectory);
  const file = await realpath(join(directory, "guoba.support.js")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (file === undefined) return;
  const path = relative(directory, file);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) || !(await stat(file)).isFile()) {
    throw new Error();
  }
  return file;
}

async function providerVersion(file: string) {
  const { dev, ino, size, mtimeNs, ctimeNs } = await stat(file, { bigint: true });
  return [dev, ino, size, mtimeNs, ctimeNs].join(":");
}

async function queueWrite(file: string, run: () => Promise<GuobaResult>) {
  const writing = Promise.resolve(writeQueues.get(file)).then(run);
  writeQueues.set(file, writing);
  try {
    return await writing;
  } finally {
    if (writeQueues.get(file) === writing) writeQueues.delete(file);
  }
}

export async function loadGuobaForm(pluginDirectory: string): Promise<GuobaForm | undefined> {
  try {
    const file = await supportFile(pluginDirectory);
    if (file === undefined) return;
    const version = await providerVersion(file);
    if (!providerVersions.has(file)) providerVersions.set(file, version);
    const { supportGuoba } = await import(pathToFileURL(file).href);
    if (typeof supportGuoba !== "function") throw new Error();
    const support: unknown = await supportGuoba();
    if (!record(support)) throw new Error();
    const { configInfo } = support;
    if (configInfo === undefined || configInfo === null) return;
    if (!record(configInfo)) throw new Error();
    const { schemas: raw, getConfigData, setConfigData } = configInfo;
    if (!Array.isArray(raw) || typeof getConfigData !== "function") throw new Error();
    const configSchemas = raw.map(item => normaliseField(item));
    const compiled = compile(configSchemas.filter(item => item !== undefined));
    const allowed = guobaActions(raw, providerVersions.get(file) === version ? configInfo.actions : undefined, field => {
      const schema = compiled.fields.get(field)?.schema;
      return schema !== undefined && schema.component !== "InputPassword" && schema.component !== "GSubForm" && !labeledTree(schema) &&
        !(schema.component === "Cascader" && schema.componentProps?.multiple);
    });
    const schemas = configSchemas.map((schema, index) => schema ?? allowed.groups.get(index))
      .filter(item => item !== undefined);
    if (!compiled.fields.size && !allowed.actions.size) return;
    const writable = compiled.fields.size > 0 && typeof setConfigData === "function";
    const actionInputs = [...allowed.fields].map(field => compiled.fields.get(field)!);
    const actionContract = JSON.stringify(actionInputs.map(({ schema }) => schema));

    const readData = async (): Promise<Record<string, unknown>> => {
      const data: unknown = await getConfigData.call(configInfo);
      if (!record(data)) throw new Error();
      return data;
    };

    function actionSnapshot(data: Record<string, unknown>) {
      const values: Record<string, GuobaInput> = Object.create(null);
      for (const { schema, parts } of actionInputs) {
        const value = getValue(data, schema.field, parts);
        if (value !== undefined) values[schema.field] = inputValue(schema, value);
      }
      const revision = createHmac("sha256", subformSecret)
        .update(JSON.stringify([file, version, allowed.definition, actionContract, values])).digest("hex");
      return { values, revision };
    }

    return {
      schemas,
      writable,
      async read() {
        try {
          const data = await readData();
          const values: Record<string, GuobaInput> = Object.create(null);
          const configuredPasswords: string[] = [];
          const subforms: Record<string, GuobaSubformSnapshot> = Object.create(null);
          for (const [field, { schema, parts }] of compiled.fields) {
            const value = getValue(data, field, parts);
            if (schema.component === "InputPassword") {
              if (typeof value === "string" && value.length > 0) configuredPasswords.push(field);
            } else if (schema.component === "GSubForm") {
              subforms[field] = subformSnapshot(file, schema, readRows(schema, value));
            } else if (value !== undefined) {
              values[field] = displayValue(schema, value);
            }
          }
          return { values, configuredPasswords, ...(Object.keys(subforms).length ? { subforms } : {}),
            ...(allowed.actions.size ? { actionRevision: actionSnapshot(data).revision } : {}) };
        } catch {
          throw new Error($t("lib.panel-guoba.text_ba82e02bb0"));
        }
      },
      async save(data, guard) {
        if (!writable || typeof setConfigData !== "function") return { ok: false, status: 405, message: $t("lib.panel-guoba.text_3b6de8842d") };
        let values: Record<string, unknown>;
        try {
          values = submitted(data, compiled);
        } catch {
          return { ok: false, status: 400, message: $t("lib.panel-guoba.text_71e6dfe8d1") };
        }
        const changedFields = Object.freeze(Object.keys(values));

        return queueWrite(file, async () => {
          try {
            if (guard && (guard.signal.aborted || !guard.verify())) {
              return { ok: false, status: 401, message: $t("lib.panel-guoba.text_92caaefd8b") };
            }
            let current: Record<string, unknown> | undefined;
            for (const [field, { schema, parts }] of compiled.fields) {
              if (schema.component === "GSubForm") {
                current ??= await readData();
                const existing = getValue(current, field, parts);
                if (Object.hasOwn(values, field)) {
                  values[field] = mergeSubform(file, schema, readRows(schema, existing), values[field] as GuobaSubformEdit);
                } else if (existing !== undefined) {
                  values[field] = schema.componentProps?.multiple === false ? existing : readRows(schema, existing);
                }
                continue;
              }
              if (labeledTree(schema)) {
                current ??= await readData();
                const existing = getValue(current, field, parts);
                if (Object.hasOwn(values, field)) values[field] = storedValue(schema, values[field] as GuobaInput, existing);
                else if (existing !== undefined) values[field] = existing;
                continue;
              }
              if (Object.hasOwn(values, field) && !(schema.component === "InputPassword" && values[field] === "")) continue;
              delete values[field];
              current ??= await readData();
              const existing = getValue(current, field, parts);
              if (existing !== undefined) values[field] = inputValue(schema, existing);
            }
            if (guard) {
              const sameProvider = providerVersions.get(file) === version &&
                await supportFile(pluginDirectory).catch(() => undefined) === file &&
                await providerVersion(file).catch(() => undefined) === version;
              if (!sameProvider || !guard.registered()) {
                return { ok: false, status: 409, message: $t("lib.panel-guoba.text_912344073e") };
              }
              if (guard.signal.aborted || !guard.verify()) {
                return { ok: false, status: 401, message: $t("lib.panel-guoba.text_92caaefd8b") };
              }
            }
            // Legacy setters still receive the expanded form. Opt-in setters can edit only the submitted fields.
            const result: unknown = await setConfigData.call(configInfo, values, { Result, changedFields });
            if (result instanceof Result && !result.isOk) {
              const status = result.httpStatus;
              return { ok: false, status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 400,
                message: $t("lib.panel-guoba.text_f71df173e4") };
            }
            return { ok: true, status: 200, message: $t("lib.panel-guoba.text_09d89ed905") };
          } catch (error) {
            if (error instanceof SubformConflict) return { ok: false, status: 409, message: $t("lib.panel-guoba.text_8cedc84def") };
            if (error instanceof SubformInputError) return { ok: false, status: 400, message: $t("lib.panel-guoba.text_edd788753b") };
            return { ok: false, status: 500, message: $t("lib.panel-guoba.text_534fc40b47") };
          }
        });
      },
      async action(data, verify, registered, signal) {
        if (!record(data) || !Object.keys(data).every(key => ["button", "revision", "fields"].includes(key)) ||
            typeof data.button !== "string" || typeof data.revision !== "string" || !/^[a-f0-9]{64}$/u.test(data.revision)) {
          return { ok: false, status: 400, message: $t("lib.panel-guoba.text_5752da48b4") };
        }
        const selected = allowed.actions.get(data.button);
        if (!selected || selected.button.disabled) return { ok: false, status: 404, message: $t("lib.panel-guoba.text_1e66b08d27") };
        let edits: Record<string, GuobaInput>;
        try {
          const input = submitted(data.fields === undefined ? {} : data.fields, compiled);
          if (!Object.keys(input).every(key => selected.button.fields.includes(key))) throw new Error();
          edits = input as Record<string, GuobaInput>;
        } catch {
          return { ok: false, status: 400, message: $t("lib.panel-guoba.text_a8b9d4d733") };
        }
        return queueWrite(file, async () => {
          try {
            if (signal.aborted || !verify()) return { ok: false, status: 401, message: $t("lib.panel-guoba.text_92caaefd8b") };
            if (!registered()) return { ok: false, status: 409, message: $t("lib.panel-guoba.text_912344073e") };
            const current = actionSnapshot(await readData());
            if (current.revision !== data.revision || !registered() || await supportFile(pluginDirectory) !== file ||
                await providerVersion(file).catch(() => undefined) !== version) {
              return { ok: false, status: 409, message: $t("lib.panel-guoba.text_912344073e") };
            }
            for (const [field, value] of Object.entries(edits)) {
              const options = compiled.fields.get(field)?.schema.componentProps?.options;
              if (options?.some(({ disabled, value: option }) =>
                disabled && [value].flat().includes(option) !== [current.values[field]].flat().includes(option))) {
                return { ok: false, status: 400, message: $t("lib.panel-guoba.text_d1c0af1690") };
              }
            }
            const args = resolveGuobaArguments(selected.args, { ...current.values, ...edits });
            if (JSON.stringify(args).length > 16_384) return { ok: false, status: 400, message: $t("lib.panel-guoba.text_8a79013d25") };
            if (!registered()) return { ok: false, status: 409, message: $t("lib.panel-guoba.text_912344073e") };
            if (signal.aborted || !verify()) return { ok: false, status: 401, message: $t("lib.panel-guoba.text_92caaefd8b") };
            const handler = selected.handler;
            const result = await handler(args, { Result });
            if (result instanceof Result && result.isOk) {
              return { ok: true, status: 200, message: $t("lib.panel-guoba.text_b25927712a") };
            }
            return { ok: false, status: 422, message: $t("lib.panel-guoba.text_194947fa2e") };
          } catch {
            return { ok: false, status: 500, message: $t("lib.panel-guoba.text_b542846062") };
          }
        });
      },
    };
  } catch {
    throw new Error($t("lib.panel-guoba.text_9ed69d4d2b"));
  }
}
