import { describe, it } from 'vitest';
import { z } from 'zod';
import { dataBodySchema, paginatedBodySchema } from '@dommaker/studio-contract';
import { defineRoute, paginated } from '../http.js';
import '../../middleware/auth.js';

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

interface DomainItem { id: string; title: string }
const passthroughItemResponseSchema = dataBodySchema(z.object({ id: z.string(), title: z.string() }).passthrough());
defineRoute({ response: passthroughItemResponseSchema }, async (): Promise<DomainItem> => ({ id: 'item-1', title: 'domain' }));

// @ts-expect-error passthrough 只放宽额外键，已知必填键仍不可缺失
defineRoute({ response: passthroughItemResponseSchema }, async (): Promise<{ id: string }> => ({ id: 'item-1' }));

const nestedItemsResponseSchema = dataBodySchema(z.object({
  items: z.record(z.string(), z.object({ id: z.string() }).passthrough()),
}));
defineRoute({ response: nestedItemsResponseSchema }, async (): Promise<{ items: Record<string, DomainItem> }> => ({
  items: { a: { id: 'item-1', title: 'nested' } },
}));

describe('defineRoute response 类型', () => {
  it.skip('纯编译期回归；由 tsc 行使上述 @ts-expect-error 断言', () => {});
});
