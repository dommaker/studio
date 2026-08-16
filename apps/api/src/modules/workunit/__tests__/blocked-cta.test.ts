// #176（决策 #57 D3-1）：blocked-cta 统一行动召唤模板测试 —— 纯函数零依赖，直接断言文案三件套
import { describe, it, expect } from 'vitest';
import { buildDeadLetterNotice, withBlockedCta } from '../blocked-cta.js';

describe('blocked-cta 模板', () => {
  it('buildDeadLetterNotice：已关闭 + 出路 + 原因摘要（截断 120 字符）', () => {
    const notice = buildDeadLetterNotice('标题', 'stuck: 连续 3 步无进展');
    expect(notice).toContain('任务「标题」');
    expect(notice).toContain('已自动关闭');
    expect(notice).toContain('stuck: 连续 3 步无进展');
    expect(notice).toContain('如需继续请重新派发');

    const long = buildDeadLetterNotice('标题', `timeout: ${'x'.repeat(200)}`);
    expect(long.length).toBeLessThan(200);
  });

  it('withBlockedCta：headline + 原因 + 统一 CTA 三件套；无原因时省略原因行', () => {
    const withReason = withBlockedCta('headline', 'stuck: x');
    expect(withReason).toContain('headline');
    expect(withReason).toContain('失败原因：stuck: x');
    expect(withReason).toContain('回复本线程即可继续执行');
    expect(withReason).toContain('回复「关闭」即可');
    expect(withReason).toContain('24 小时无介入将自动关闭并通知');

    const noReason = withBlockedCta('headline');
    expect(noReason).not.toContain('失败原因');
    expect(noReason).toContain('回复本线程即可继续执行');
  });
});
