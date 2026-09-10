// 批次 D-1.5：系统播报行首严重度前缀解析（parseSeverityPrefix）——
// 仅行首 [CRITICAL]/[WARNING] 命中并剥除；[INFO] 与非行首/小写形态一律原样透传。
import { describe, it, expect } from 'vitest';
import { parseSeverityPrefix } from '../severityPrefix';

describe('parseSeverityPrefix（批次 D-1.5）', () => {
  it('[CRITICAL] 前缀 → critical，rest 剥掉前缀与尾随空白', () => {
    expect(parseSeverityPrefix('[CRITICAL] **[Monitor]** 数据库连接失败')).toEqual({
      level: 'critical',
      rest: '**[Monitor]** 数据库连接失败',
    });
  });

  it('[WARNING] 前缀 → warning', () => {
    expect(parseSeverityPrefix('[WARNING] 内存水位 85%')).toEqual({
      level: 'warning',
      rest: '内存水位 85%',
    });
  });

  it('[INFO] 不出 chip（任务边界：只 chip 化 critical/warning）', () => {
    expect(parseSeverityPrefix('[INFO] 巡检完成')).toBeNull();
  });

  it('无前缀的普通播报 → null', () => {
    expect(parseSeverityPrefix('WorkUnit 已完成')).toBeNull();
  });

  it('非行首出现不命中', () => {
    expect(parseSeverityPrefix('注意 [CRITICAL] 级别')).toBeNull();
  });

  it('小写 [critical] 不命中（生产端正本是大写，不误吞用户文本）', () => {
    expect(parseSeverityPrefix('[critical] x')).toBeNull();
  });

  it('前缀后换行同样剥除（含 \\s 类空白）', () => {
    expect(parseSeverityPrefix('[WARNING]\n正文')).toEqual({ level: 'warning', rest: '正文' });
  });
});
