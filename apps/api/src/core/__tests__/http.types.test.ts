import { describe, it } from 'vitest';
import { z } from 'zod';
import { dataBodySchema, paginatedBodySchema } from '@dommaker/studio-contract';
import { defineRoute, paginated } from '../http.js';

const itemSchema = z.object({ id: z.string() });
const itemResponseSchema = dataBodySchema(itemSchema);
const itemListResponseSchema = paginatedBodySchema(itemSchema);

defineRoute({ response: itemResponseSchema }, async () => ({ id: 'item-1' }));

// @ts-expect-error handler 必须返回 response.data 声明的完整形状
defineRoute({ response: itemResponseSchema }, async () => ({ title: 'missing id' }));

defineRoute({ response: itemListResponseSchema }, async () =>
  paginated([{ id: 'item-1' }], { page: 1, limit: 20, total: 1, totalPages: 1 }),
);

// @ts-expect-error 分页 response 必须返回 paginated() 的 data + pagination 形状
defineRoute({ response: itemListResponseSchema }, async () => [{ id: 'item-1' }]);

describe('defineRoute response 类型', () => {
  it.skip('纯编译期回归；由 tsc 行使上述 @ts-expect-error 断言', () => {});
});
