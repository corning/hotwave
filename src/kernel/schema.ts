/**
 * 极简 schema 层：参数/输出规格 → JSON Schema，并提供子集校验
 *
 * 设计取舍：只覆盖我们真实用到的 JSON Schema 子集，不引入第三方校验库，
 * 保证 hotwave 零外部运行时依赖。
 *
 * 支持的规格（与 DSH 的 parameters DSL 同形，便于迁移）：
 *   { type:'string'|'number'|'integer'|'boolean'|'null'|'json'|'array'|'object',
 *     description?, enum?, items?, properties?, additionalProperties?, required? }
 */

export type ValueSpec = {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'json' | 'array' | 'object';
  description?: string;
  enum?: readonly (string | number | boolean | null)[];
  items?: ValueSpec;
  properties?: ParameterSpec;
  additionalProperties?: boolean;
  required?: true;
};

export type ParameterSpec = Record<string, ValueSpec>;

export type JsonSchema = Record<string, any>;

/** 参数属性表 → JSON Schema（隐式开放对象根） */
export function parametersToJsonSchema(spec: ParameterSpec): JsonSchema {
  const properties: JsonSchema = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(spec)) {
    properties[key] = valueSpecToJsonSchema(value);
    if (value?.required === true) required.push(key);
  }
  const schema: JsonSchema = { type: 'object', properties, additionalProperties: true };
  if (required.length > 0) schema.required = required;
  return schema;
}

export function valueSpecToJsonSchema(spec: ValueSpec): JsonSchema {
  const out: JsonSchema = {};
  const t = spec?.type;
  if (spec?.description) out.description = spec.description;
  if (spec?.enum) out.enum = [...spec.enum];

  switch (t) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      out.type = t;
      break;
    case 'array':
      out.type = 'array';
      if (spec.items) out.items = valueSpecToJsonSchema(spec.items);
      break;
    case 'object': {
      out.type = 'object';
      const props: JsonSchema = {};
      const req: string[] = [];
      for (const [k, v] of Object.entries(spec.properties ?? {})) {
        props[k] = valueSpecToJsonSchema(v);
        if (v?.required === true) req.push(k);
      }
      out.properties = props;
      out.required = req;
      out.additionalProperties = spec.additionalProperties === true;
      break;
    }
    case 'json':
      // 任意无损 JSON：不写 type，交给上层按值接受
      break;
    default:
      break;
  }
  return out;
}

/** 类型判定（严格：integer 不接受 1.5） */
function matchesType(schema: JsonSchema, value: unknown): boolean {
  const t = schema?.type;
  if (!t) return true;
  switch (t) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    default: return true;
  }
}

/** 校验一个值，返回违规列表（空数组 = 通过） */
export function validateValue(schema: JsonSchema, value: unknown, path = ''): string[] {
  const violations: string[] = [];
  const at = path || '(root)';

  if (schema?.enum && !schema.enum.includes(value as any)) {
    violations.push(at + ' 不在允许取值内: ' + JSON.stringify(schema.enum));
    return violations;
  }
  if (!matchesType(schema, value)) {
    violations.push(at + ' 期望 ' + schema.type + '，实际 ' + (Array.isArray(value) ? 'array' : typeof value));
    return violations;
  }

  if (schema?.type === 'array' && schema.items) {
    (value as unknown[]).forEach((item, i) => {
      violations.push(...validateValue(schema.items, item, at + '[' + i + ']'));
    });
  }

  if (schema?.type === 'object' && value) {
    const obj = value as Record<string, unknown>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in obj) || obj[key] === undefined) {
        violations.push(at + ' 缺少必填字段 "' + key + '"');
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in obj && obj[key] !== undefined) {
        violations.push(...validateValue(child as JsonSchema, obj[key], at + '.' + key));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in (schema.properties ?? {}))) {
          violations.push(at + ' 出现未声明字段 "' + key + '"');
        }
      }
    }
  }
  return violations;
}
