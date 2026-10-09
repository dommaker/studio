/**
 * openapi.ts — zod schema → OpenAPI 3.0 SchemaObject 轻量转换器。
 *
 * OpenAPI 文档是 contract 的派生物（CONTEXT.md：不手写 yaml）。本转换器只覆盖
 * 仓内 contract 实际用到的 zod 子集（zod 3）：
 *   string / number / boolean / null / enum / literal / unknown / any
 *   object（optional/nullable/passthrough/strict/strip、extend/omit 产物同样是 ZodObject）
 *   array / record / union / discriminatedUnion
 *   修饰：min/max/trim/regex（string）、int/positive/nonnegative（number）、refine（透传 unwrap）、default（unwrap）
 * 未覆盖的类型退化为 `{}`（不拒绝任何 JSON），并在 x-studio-unconverted 标注原 typeName。
 *
 * 约定：OpenAPI 3.0（nullable: true 形态，非 3.1 的 type: ['x','null']）。
 * 纯函数、零 Node 依赖——apps/web 也 import 本包，保持浏览器可用。
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

type Def = { typeName: string } & Record<string, unknown>;

function defOf(schema: z.ZodTypeAny): Def {
  return schema._def as Def;
}

function stringChecks(def: Def, out: OpenAPISchema): void {
  for (const check of (def.checks as Array<{ kind: string; value?: unknown; regex?: RegExp }> | undefined) ?? []) {
    if (check.kind === 'min') out.minLength = check.value as number;
    else if (check.kind === 'max') out.maxLength = check.value as number;
    else if (check.kind === 'regex' && check.regex) out.pattern = check.regex.source;
  }
}

function numberChecks(def: Def, out: OpenAPISchema): void {
  for (const check of (def.checks as Array<{ kind: string; value?: number; inclusive?: boolean }> | undefined) ?? []) {
    if (check.kind === 'int') out.type = 'integer';
    else if (check.kind === 'min') {
      out.minimum = check.value;
      if (check.inclusive === false) out.exclusiveMinimum = true;
    } else if (check.kind === 'max') {
      out.maximum = check.value;
    }
  }
}

/** zod → OpenAPI 3.0 SchemaObject（递归）。 */
export function zodToOpenAPISchema(schema: z.ZodTypeAny): OpenAPISchema {
  const def = defOf(schema);
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString: {
      const out: OpenAPISchema = { type: 'string' };
      stringChecks(def, out);
      return out;
    }
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const out: OpenAPISchema = { type: 'number' };
      numberChecks(def, out);
      return out;
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: 'boolean' };
    case z.ZodFirstPartyTypeKind.ZodNull:
      return { nullable: true };
    case z.ZodFirstPartyTypeKind.ZodUnknown:
    case z.ZodFirstPartyTypeKind.ZodAny:
      return {};
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { type: 'string', enum: [...(def.values as string[])] };
    case z.ZodFirstPartyTypeKind.ZodLiteral: {
      const value = def.value as unknown;
      const out: OpenAPISchema = { enum: [value] };
      if (typeof value === 'string') out.type = 'string';
      else if (typeof value === 'number') out.type = 'number';
      else if (typeof value === 'boolean') out.type = 'boolean';
      return out;
    }
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const out: OpenAPISchema = {
        type: 'array',
        items: zodToOpenAPISchema(def.type as z.ZodTypeAny),
      };
      if (typeof def.minLength === 'object' && def.minLength !== null) {
        out.minItems = (def.minLength as { value: number }).value;
      }
      if (typeof def.maxLength === 'object' && def.maxLength !== null) {
        out.maxItems = (def.maxLength as { value: number }).value;
      }
      return out;
    }
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (def.shape as () => z.ZodRawShape)();
      const properties: Record<string, OpenAPISchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToOpenAPISchema(value);
        // zod 的 isOptional() = safeParse(undefined).success，覆盖 optional/default 两种免填
        if (!value.isOptional()) required.push(key);
      }
      const out: OpenAPISchema = { type: 'object', properties };
      if (required.length > 0) out.required = required;
      const unknownKeys = def.unknownKeys as string | undefined;
      const catchall = def.catchall as z.ZodTypeAny | undefined;
      if (unknownKeys === 'passthrough') {
        // .passthrough() 的 catchall 是 ZodNever（zod ≥3.23；旧版 ZodUnknown）→ true；
        // 显式 .catchall(schema) 则带形状
        const catchallType = catchall ? defOf(catchall).typeName : undefined;
        out.additionalProperties =
          catchall
          && catchallType !== z.ZodFirstPartyTypeKind.ZodUnknown
          && catchallType !== z.ZodFirstPartyTypeKind.ZodNever
            ? zodToOpenAPISchema(catchall)
            : true;
      } else if (unknownKeys === 'strict') {
        out.additionalProperties = false;
      }
      // strip（缺省）：不写 additionalProperties——额外键是「静默剥掉」而非「拒绝」，不误导调用方
      const description = def.description as string | undefined;
      if (description) out.description = description;
      return out;
    }
    case z.ZodFirstPartyTypeKind.ZodRecord: {
      return {
        type: 'object',
        additionalProperties: zodToOpenAPISchema(def.valueType as z.ZodTypeAny),
      };
    }
    case z.ZodFirstPartyTypeKind.ZodUnion: {
      return { anyOf: (def.options as z.ZodTypeAny[]).map(zodToOpenAPISchema) };
    }
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
      return {
        oneOf: [...(def.options as Map<string, z.ZodTypeAny>).values()].map(zodToOpenAPISchema),
        discriminator: { propertyName: def.discriminator as string },
      };
    }
    case z.ZodFirstPartyTypeKind.ZodNullable: {
      const inner = zodToOpenAPISchema(def.innerType as z.ZodTypeAny);
      // 内层已是 anyOf/oneOf 时包一层 anyOf + null 形态无法用 3.0 表达，退化为 nullable 标注
      return { ...inner, nullable: true };
    }
    case z.ZodFirstPartyTypeKind.ZodOptional: {
      return zodToOpenAPISchema(def.innerType as z.ZodTypeAny);
    }
    case z.ZodFirstPartyTypeKind.ZodDefault: {
      const inner = zodToOpenAPISchema(def.innerType as z.ZodTypeAny);
      const defaultValue = (def.defaultValue as () => unknown)();
      return { ...inner, default: defaultValue };
    }
    case z.ZodFirstPartyTypeKind.ZodEffects: {
      // refine/superRefine/transform：校验语义进不了 JSON Schema，透传内层形状
      return zodToOpenAPISchema(def.schema as z.ZodTypeAny);
    }
    case z.ZodFirstPartyTypeKind.ZodReadonly: {
      return zodToOpenAPISchema(def.innerType as z.ZodTypeAny);
    }
    case z.ZodFirstPartyTypeKind.ZodCatch: {
      return zodToOpenAPISchema(def.innerType as z.ZodTypeAny);
    }
    default:
      // 未覆盖子集（tuple/intersection/date/lazy…）：不拒绝任何 JSON，留标注便于补齐
      return { 'x-studio-unconverted': def.typeName };
  }
}
