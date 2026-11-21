import { createHmac, randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { guobaActions, resolveGuobaArguments } from "./panel-guoba-actions.ts";

const components = [
  "Divider", "Input", "InputPassword", "InputTextArea", "InputNumber", "Switch", "Select", "EasyCron", "GSubForm",
  "CheckboxGroup",
] as const;
type Component = typeof components[number] | "GButtons";
type Scalar = string | number | boolean | null;
export type GuobaInput = Scalar | Scalar[];

export interface GuobaSubformRow {
  readonly values: Readonly<Record<string, GuobaInput>>;
  readonly configuredPasswords: readonly string[];
}

export interface GuobaSubformSnapshot {
  readonly revision: string;
  readonly rows: readonly GuobaSubformRow[];
}

export interface GuobaSubformEdit {
  readonly revision: string;
  readonly rows: readonly { index: number | null; values: Record<string, GuobaInput> }[];
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

function normaliseField(schema: unknown, child = false): GuobaField | undefined {
  if (!record(schema)) throw new Error();
  const group = schema.component === "SOFT_GROUP_BEGIN";
  const component = group ? "Divider" : components.find((name) => name === schema.component);
  if (!component) return undefined;
  if (component === "CheckboxGroup" && child) return undefined;
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
    if (child || !record(raw) || !Array.isArray(raw.schemas) ||
        (raw.multiple !== undefined && typeof raw.multiple !== "boolean")) return undefined;
    props.multiple = raw.multiple === true;
    props.schemas = raw.schemas.map(item => normaliseField(item, true)).filter(item => item !== undefined);
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
    const { placeholder, rows, min, max, step, options, mode, defaultValue, addonAfter } = schema.componentProps;
    if (typeof placeholder === "string") props.placeholder = placeholder;
    if (typeof rows === "number" && Number.isSafeInteger(rows) && rows > 0) props.rows = rows;
    if (typeof min === "number" && Number.isFinite(min)) props.min = min;
    if (typeof max === "number" && Number.isFinite(max)) props.max = max;
    if (typeof step === "number" && Number.isFinite(step) && step > 0) props.step = step;
    if (mode === "multiple" || mode === "tags") props.mode = mode;
    if (component === "CheckboxGroup") props.mode = "multiple";
    if (child && typeof addonAfter === "string") props.addonAfter = addonAfter;
    if (child && (scalar(defaultValue) || (Array.isArray(defaultValue) && defaultValue.every(scalar)))) {
      props.defaultValue = defaultValue;
    }
    if (Array.isArray(options)) {
      props.options = options.flatMap((option: unknown) => {
        if (component === "CheckboxGroup" && (typeof option === "string" ||
            (typeof option === "number" && Number.isFinite(option)))) return [{ label: String(option), value: option }];
        if (!record(option) || !scalar(option.value) || (!child && typeof option.label !== "string")) return [];
        const { label: optionLabel, value, disabled } = option;
        return [{ label: typeof optionLabel === "string" ? optionLabel : String(value), value,
          ...(typeof disabled === "boolean" ? { disabled } : {}) }];
      });
    }
  }
  if (child && component !== "InputPassword" &&
      (scalar(schema.defaultValue) || (Array.isArray(schema.defaultValue) && schema.defaultValue.every(scalar)))) {
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
  }
  throw new Error();
}

function submittedValue(schema: ValueField, raw: unknown): GuobaInput {
  const value = inputValue(schema, raw);
  if (value === null) return value;
  const { componentProps: props } = schema;
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
  return { revision: subformRevision(file, schema.field, rows), rows: rows.map(row => {
    const values: Record<string, GuobaInput> = Object.create(null);
    const configuredPasswords: string[] = [];
    for (const child of schema.componentProps?.schemas ?? []) {
      if (!child.field || !Object.hasOwn(row, child.field)) continue;
      const value = row[child.field];
      if (child.component === "InputPassword") {
        if (typeof value === "string" && value.length) configuredPasswords.push(child.field);
      } else if (value !== undefined) {
        values[child.field] = inputValue({ ...child, field: child.field }, value);
      }
    }
    return { values, configuredPasswords };
  }) };
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
      return [field, submittedValue(child.schema, value)] as const;
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
    const row = { ...existing, ...values };
    const changed = index === null || Object.keys(values).length > 0;
    for (const child of fields) {
      if (!child.field) continue;
      if (single && changed && row[child.field] === undefined && child.componentProps?.defaultValue !== undefined) {
        row[child.field] = child.componentProps.defaultValue;
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
      return schema !== undefined && schema.component !== "InputPassword" && schema.component !== "GSubForm";
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
              values[field] = inputValue(schema, value);
            }
          }
          return { values, configuredPasswords, ...(Object.keys(subforms).length ? { subforms } : {}),
            ...(allowed.actions.size ? { actionRevision: actionSnapshot(data).revision } : {}) };
        } catch {
          throw new Error("无法读取插件配置。");
        }
      },
      async save(data, guard) {
        if (!writable || typeof setConfigData !== "function") return { ok: false, status: 405, message: "此插件表单只读。" };
        let values: Record<string, unknown>;
        try {
          values = submitted(data, compiled);
        } catch {
          return { ok: false, status: 400, message: "插件表单包含未知字段或无效值。" };
        }
        const changedFields = Object.freeze(Object.keys(values));

        return queueWrite(file, async () => {
          try {
            if (guard && (guard.signal.aborted || !guard.verify())) {
              return { ok: false, status: 401, message: "面板登录已失效。" };
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
                return { ok: false, status: 409, message: "插件表单已变更，请重新读取。" };
              }
              if (guard.signal.aborted || !guard.verify()) {
                return { ok: false, status: 401, message: "面板登录已失效。" };
              }
            }
            // Legacy setters still receive the expanded form. Opt-in setters can edit only the submitted fields.
            const result: unknown = await setConfigData.call(configInfo, values, { Result, changedFields });
            if (result instanceof Result && !result.isOk) {
              const status = result.httpStatus;
              return { ok: false, status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 400,
                message: "插件拒绝保存配置。" };
            }
            return { ok: true, status: 200, message: "配置已保存。" };
          } catch (error) {
            if (error instanceof SubformConflict) return { ok: false, status: 409, message: "子表单已变更，请重新读取。" };
            if (error instanceof SubformInputError) return { ok: false, status: 400, message: "子表单包含无效或缺少必填的值。" };
            return { ok: false, status: 500, message: "无法保存插件配置。" };
          }
        });
      },
      async action(data, verify, registered, signal) {
        if (!record(data) || !Object.keys(data).every(key => ["button", "revision", "fields"].includes(key)) ||
            typeof data.button !== "string" || typeof data.revision !== "string" || !/^[a-f0-9]{64}$/u.test(data.revision)) {
          return { ok: false, status: 400, message: "插件操作请求无效。" };
        }
        const selected = allowed.actions.get(data.button);
        if (!selected || selected.button.disabled) return { ok: false, status: 404, message: "插件操作不可用。" };
        let edits: Record<string, GuobaInput>;
        try {
          const input = submitted(data.fields === undefined ? {} : data.fields, compiled);
          if (!Object.keys(input).every(key => selected.button.fields.includes(key))) throw new Error();
          edits = input as Record<string, GuobaInput>;
        } catch {
          return { ok: false, status: 400, message: "插件操作包含未知字段或无效值。" };
        }
        return queueWrite(file, async () => {
          try {
            if (signal.aborted || !verify()) return { ok: false, status: 401, message: "面板登录已失效。" };
            if (!registered()) return { ok: false, status: 409, message: "插件表单已变更，请重新读取。" };
            const current = actionSnapshot(await readData());
            if (current.revision !== data.revision || !registered() || await supportFile(pluginDirectory) !== file ||
                await providerVersion(file).catch(() => undefined) !== version) {
              return { ok: false, status: 409, message: "插件表单已变更，请重新读取。" };
            }
            for (const [field, value] of Object.entries(edits)) {
              const options = compiled.fields.get(field)?.schema.componentProps?.options;
              if (options?.some(({ disabled, value: option }) =>
                disabled && [value].flat().includes(option) !== [current.values[field]].flat().includes(option))) {
                return { ok: false, status: 400, message: "插件操作包含当前不可选的值。" };
              }
            }
            const args = resolveGuobaArguments(selected.args, { ...current.values, ...edits });
            if (JSON.stringify(args).length > 16_384) return { ok: false, status: 400, message: "插件操作参数过长。" };
            if (!registered()) return { ok: false, status: 409, message: "插件表单已变更，请重新读取。" };
            if (signal.aborted || !verify()) return { ok: false, status: 401, message: "面板登录已失效。" };
            const handler = selected.handler;
            const result = await handler(args, { Result });
            if (result instanceof Result && result.isOk) {
              return { ok: true, status: 200, message: "插件操作已完成。" };
            }
            return { ok: false, status: 422, message: "插件未确认操作完成，请检查当前状态。" };
          } catch {
            return { ok: false, status: 500, message: "无法确认插件操作结果，请检查当前状态。" };
          }
        });
      },
    };
  } catch {
    throw new Error("无法加载插件表单。");
  }
}
