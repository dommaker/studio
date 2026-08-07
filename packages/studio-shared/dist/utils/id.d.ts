/**
 * 生成带前缀的唯一 ID：`${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`。
 * 全仓同一模式的 ID 生成统一收敛到本函数（工单42），调用方只需提供前缀。
 */
export declare function generateId(prefix: string): string;
//# sourceMappingURL=id.d.ts.map