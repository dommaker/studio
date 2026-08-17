/**
 * gen-agents-md — 模块索引生成器单元测试（#152：摘要源改 .studio/CONTEXT.md 锚点）
 * parseAnchors / extractSummary
 */
import { describe, it, expect } from 'vitest';
import { parseAnchors, extractSummary } from '../gen-agents-md.mjs';

const SAMPLE = `# Studio 模块上下文（唯一沉淀正本）

> 头部说明

## apps/api/src/modules/alpha

### 职责

负责 alpha 模块的 CRUD 与事件分发。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| \`router\` | \`routes.ts\` | Express Router |

## apps/api/src/modules/beta

### 注意事项

- 没有职责节时的回退样例

## packages/gamma/src

跨 apps 共享的 gamma 工具层。
`;

describe('parseAnchors()', () => {
  it('按二级标题切锚点，正文到下一个二级标题为止', () => {
    const anchors = parseAnchors(SAMPLE);
    expect([...anchors.keys()]).toEqual([
      'apps/api/src/modules/alpha',
      'apps/api/src/modules/beta',
      'packages/gamma/src',
    ]);
    expect(anchors.get('apps/api/src/modules/alpha')).toContain('负责 alpha 模块');
    expect(anchors.get('apps/api/src/modules/alpha')).not.toContain('回退样例');
  });

  it('更深标题（###）不构成锚点', () => {
    const anchors = parseAnchors(SAMPLE);
    expect(anchors.has('职责')).toBe(false);
    expect(anchors.has('核心导出')).toBe(false);
  });
});

describe('extractSummary()', () => {
  it('优先取「职责」节首行（任意标题级）', () => {
    const anchors = parseAnchors(SAMPLE);
    expect(extractSummary(anchors.get('apps/api/src/modules/alpha'))).toBe('负责 alpha 模块的 CRUD 与事件分发。');
  });

  it('无「职责」节时回退首个正文段落（跳过标题/引用/列表/表格）', () => {
    const anchors = parseAnchors(SAMPLE);
    expect(extractSummary(anchors.get('apps/api/src/modules/beta'))).toBe('（锚点为空）');
    expect(extractSummary(anchors.get('packages/gamma/src'))).toBe('跨 apps 共享的 gamma 工具层。');
  });

  it('锚点不存在 → null（由表格行渲染缺锚点提示）', () => {
    expect(extractSummary(undefined)).toBeNull();
  });

  it('去反引号/竖线，超 120 字截断', () => {
    const withCode = parseAnchors('## m\n\n### 职责\n\n`foo` | 管道 | 说明\n');
    expect(extractSummary(withCode.get('m'))).toBe('foo  管道  说明');
    const long = parseAnchors(`## m\n\n### 职责\n\n${'长'.repeat(200)}\n`);
    expect(extractSummary(long.get('m'))!.length).toBeLessThanOrEqual(120);
    expect(extractSummary(long.get('m'))!.endsWith('...')).toBe(true);
  });
});
