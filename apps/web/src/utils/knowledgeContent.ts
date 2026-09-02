// #435 B7：知识库统一视图内容消化——存储层原文（裸 JSON）转结构化键值，其余按文本；
// 纯函数抽出以便单测。§6.5：consumptionMode 是类别维度，徽标色走 --chart-* 类别色系，不占状态色。

export type DigestedContent =
  | { kind: 'json'; fields: Array<{ key: string; value: string }> }
  | { kind: 'text'; text: string };

/** JSON 对象原文 → 键值字段（嵌套值紧凑 JSON 串）；非对象 JSON / 普通文本 → text */
export function digestContent(content: string | undefined | null): DigestedContent {
  const text = (content ?? '').trim();
  if (!text) return { kind: 'text', text: '' };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const fields = Object.entries(parsed).map(([key, v]) => ({
        key,
        value: typeof v === 'string' ? v : JSON.stringify(v),
      }));
      if (fields.length > 0) return { kind: 'json', fields };
    }
  } catch { /* 非 JSON，按文本处理 */ }
  return { kind: 'text', text };
}

/** consumptionMode → --chart-* 调色板序号（rule 紫 / signal 青 / context 蓝，避开绿黄红状态联想）；无映射走中性色 */
export const CONSUMPTION_MODE_CHART: Record<string, number> = {
  rule: 2,
  signal: 7,
  context: 1,
};
