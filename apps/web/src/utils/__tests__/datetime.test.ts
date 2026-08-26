// utils/datetime（#358）：6 处 formatTime 拷贝 + 6 处内联 toLocaleString 的唯一出口
import { describe, expect, it } from 'vitest';
import { formatShortTime, formatFullTime } from '../datetime';

describe('formatShortTime（zh-CN 短格式「MM/DD HH:mm」）', () => {
  it('空值回 `-`（null / undefined / 空串）', () => {
    expect(formatShortTime(null)).toBe('-');
    expect(formatShortTime(undefined)).toBe('-');
    expect(formatShortTime('')).toBe('-');
  });

  it('合法时间戳 → zh-CN 短格式（月/日 时:分，各两位）', () => {
    const out = formatShortTime('2026-08-26T10:37:09');
    expect(out).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });

  it('逐字对齐原 6 份拷贝的 toLocaleString 选项', () => {
    const iso = '2026-08-26T10:37:09';
    expect(formatShortTime(iso)).toBe(
      new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    );
  });
});

describe('formatFullTime（原内联 toLocaleString ×6）', () => {
  it('合法时间戳 → zh-CN 全格式（含年月日时分）', () => {
    const out = formatFullTime('2026-08-26T10:37:09');
    expect(out).toContain('2026');
    expect(out).toBe(new Date('2026-08-26T10:37:09').toLocaleString('zh-CN'));
  });
});
