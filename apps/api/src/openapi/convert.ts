/**
 * convert.ts — zod schema → OpenAPI 3.0 SchemaObject 轻量转换器（#685 自
 * packages/studio-contract 搬入；唯一消费方为本目录 build.ts，contract 回归纯 schema 正本）。
 *
 * OpenAPI 文档是 contract 的派生物（不手写 yaml）。本转换器只覆盖
 * 仓内 contract 实际用到的 zod 子集（zod 4 `_zod.def`）：
 *   string / number / boolean / null / enum / literal / unknown / any
 *   object（optional/nullable/passthrough/strict/strip、extend/omit 产物同样是 ZodObject）
 *   array / record / union / discriminatedUnion
 *   修饰：min/max/trim/regex（string）、int/positive/nonnegative（number）、refine（透传 unwrap）、default（unwrap）
 * 未覆盖的类型退化为 `{}`（不拒绝任何 JSON），并在 x-studio-unconverted 标注原 typeName。
 *
 * 约定：OpenAPI 3.0（nullable: true 形态，非 3.1 的 type: ['x','null']）。
 */

import { z } from 'zod';

/** OpenAPI 3.0 SchemaObject（本仓用到的子集，宽松声明） */
export interface OpenAPISchema {
  type?: string;
  format?: string;
  nullable?: boolean;
  enum?: unknown[];
  properties?: Record<string, OpenAPISchema>;
  required?: string[];
  additionalProperties?: boolean | OpenAPISchema;
  items?: OpenAPISchema;
  anyOf?: OpenAPISchema[];
  oneOf?: OpenAPISchema[];
  discriminator?: { propertyName: string };
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: boolean;
  minItems?: number;
  maxItems?: number;
  description?: string;
  default?: unknown;
  'x-studio-unconverted'?: string;
}

type Def = { type: string } & Record<string, unknown>;
type Check = { _zod: { def: Record<string, unknown> } };

function defOf(schema: z.ZodType): Def {
  return schema._zod.def as Def;
}

function checksOf(def: Def): Array<Record<string, unknown>> {
  return ((def.checks as Check[] | undefined) ?? []).map((check) => check._zod.def);
}

function lengthChecks(def: Def, out: OpenAPISchema, minKey: 'minLength' | 'minItems', maxKey: 'maxLength' | 'maxItems'): void {
  for (const check of checksOf(def)) {
    if (check.check === 'min_length') out[minKey] = check.minimum as number;
    else if (check.check === 'max_length') out[maxKey] = check.maximum as number;
  }
}

function stringChecks(def: Def, out: OpenAPISchema): void {
  lengthChecks(def, out, 'minLength', 'maxLength');
  for (const check of checksOf(def)) {
    if (check.check === 'string_format' && check.format === 'regex') {
      out.pattern = (check.pattern as RegExp).source;
    }
  }
}

function numberChecks(def: Def, out: OpenAPISchema): void {
  for (const check of checksOf(def)) {
    if (check.check === 'number_format' && check.format === 'safeint') out.type = 'integer';
    else if (check.check === 'greater_than') {
      out.minimum = check.value as number;
      if (check.inclusive === false) out.exclusiveMinimum = true;
    } else if (check.check === 'less_than') {
      out.maximum = check.value as number;
    }
  }
}

/** zod → OpenAPI 3.0 SchemaObject（递归）。 */
export function zodToOpenAPISchema(schema: z.ZodType): OpenAPISchema {
  const def = defOf(schema);
  switch (def.type) {
    case 'string': {
      const out: OpenAPISchema = { type: 'string' };
      stringChecks(def, out);
      return out;
    }
    case 'number': {
      const out: OpenAPISchema = { type: 'number' };
      numberChecks(def, out);
      return out;
    }
    case 'boolean':
      return { type: 'boolean' };
    case 'null':
      return { nullable: true };
    case 'unknown':
    case 'any':
      return {};
    case 'enum':
      return { type: 'string', enum: Object.values(def.entries as Record<string, string>) };
    case 'literal': {
      const value = (def.values as unknown[])[0];
      const out: OpenAPISchema = { enum: [value] };
      if (typeof value === 'string') out.type = 'string';
      else if (typeof value === 'number') out.type = 'number';
      else if (typeof value === 'boolean') out.type = 'boolean';
      return out;
    }
    case 'array': {
      const out: OpenAPISchema = {
        type: 'array',
        items: zodToOpenAPISchema(def.element as z.ZodType),
      };
      lengthChecks(def, out, 'minItems', 'maxItems');
      return out;
    }
    case 'object': {
      const shape = def.shape as Record<string, z.ZodType>;
      const properties: Record<string, OpenAPISchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToOpenAPISchema(value);
        // zod 的 isOptional() = safeParse(undefined).success，覆盖 optional/default 两种免填
        if (!value.isOptional()) required.push(key);
      }
      const out: OpenAPISchema = { type: 'object', properties };
      if (required.length > 0) out.required = required;
      const catchall = def.catchall as z.ZodType | undefined;
      if (catchall) {
        const catchallType = defOf(catchall).type;
        out.additionalProperties = catchallType === 'never'
          ? false
          : catchallType === 'unknown'
            ? true
            : zodToOpenAPISchema(catchall);
      }
      // strip（缺省）：不写 additionalProperties——额外键是「静默剥掉」而非「拒绝」，不误导调用方
      if (schema.description) out.description = schema.description;
      return out;
    }
    case 'record':
      return {
        type: 'object',
        additionalProperties: zodToOpenAPISchema(def.valueType as z.ZodType),
      };
    case 'union': {
      const options = (def.options as z.ZodType[]).map(zodToOpenAPISchema);
      if (typeof def.discriminator === 'string') {
        return { oneOf: options, discriminator: { propertyName: def.discriminator } };
      }
      return { anyOf: options };
    }
    case 'nullable': {
      const inner = zodToOpenAPISchema(def.innerType as z.ZodType);
      // 内层已是 anyOf/oneOf 时包一层 anyOf + null 形态无法用 3.0 表达，退化为 nullable 标注
      return { ...inner, nullable: true };
    }
    case 'optional':
      return zodToOpenAPISchema(def.innerType as z.ZodType);
    case 'default':
      return {
        ...zodToOpenAPISchema(def.innerType as z.ZodType),
        default: def.defaultValue,
      };
    case 'readonly':
    case 'catch':
      return zodToOpenAPISchema(def.innerType as z.ZodType);
    default:
      // 未覆盖子集（tuple/intersection/date/lazy…）：不拒绝任何 JSON，留标注便于补齐
      return { 'x-studio-unconverted': `Zod${def.type[0]?.toUpperCase()}${def.type.slice(1)}` };
  }
}
