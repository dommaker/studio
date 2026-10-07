// knowledge-service 拆分结构测试（#669：1228 行沿六能力边界切深模块）：
// 钉住拆分契约——
//   1) 能力实现模块存在且导出 impl 函数（Produce/Consume/Track/Lifecycle/Measure）；
//   2) knowledge-types.ts 为类型正本（ENTRY_TYPE_MAP 运行时可导）；
//   3) 门面 knowledge-service.ts 公共面不破坏（既有消费方 import 的符号全部仍在）；
//   4) 门面瘦身（不再单文件巨型化），历史死副本文件已清除。
// 行为本身的覆盖率由既有 knowledge-service-* 测试网承担（纯结构移动，不改行为）。
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MODULE_DIR = path.resolve(__dirname, '..');

describe('knowledge-service 拆分：能力实现模块（#669）', () => {
  it('knowledge-produce 导出 Produce impl 函数', async () => {
    const mod = await import('../knowledge-produce.js');
    for (const fn of [
      'extractFromExecutionImpl',
      'extractFromConversationImpl',
      'recordPatternImpl',
      'recordIncidentImpl',
      'recordTrendImpl',
      'recordAnalystAccuracyImpl',
    ]) {
      expect(typeof (mod as any)[fn], fn).toBe('function');
    }
  });

  it('knowledge-consume 导出 Consume impl 函数与注入常量', async () => {
    const mod = await import('../knowledge-consume.js');
    for (const fn of [
      'injectContextImpl',
      'semanticSearchImpl',
      'searchImpl',
      'searchKeywordImpl',
      'searchSemanticImpl',
      'searchHybridImpl',
    ]) {
      expect(typeof (mod as any)[fn], fn).toBe('function');
    }
    expect((mod as any).INJECT_TOKEN_BUDGET).toBe(927);
    expect(typeof (mod as any).KNOWLEDGE_QUERY_GUIDANCE).toBe('string');
  });

  it('knowledge-track 导出 Track impl 函数', async () => {
    const mod = await import('../knowledge-track.js');
    for (const fn of ['recordConsumptionImpl', 'recordOutcomeImpl', 'recordSkillExecutionImpl']) {
      expect(typeof (mod as any)[fn], fn).toBe('function');
    }
  });

  it('knowledge-lifecycle 导出 Lifecycle impl 函数', async () => {
    const mod = await import('../knowledge-lifecycle.js');
    for (const fn of ['promoteImpl', 'demoteImpl', 'decayImpl', 'mergeImpl', 'graduateConstraintImpl']) {
      expect(typeof (mod as any)[fn], fn).toBe('function');
    }
  });

  it('knowledge-measure 导出 Measure impl 函数', async () => {
    const mod = await import('../knowledge-measure.js');
    for (const fn of [
      'getFlywheelMetricsImpl',
      'getHealthReportImpl',
      'getAuditReportImpl',
      'getAnalystAccuracyImpl',
      'getStatsImpl',
    ]) {
      expect(typeof (mod as any)[fn], fn).toBe('function');
    }
  });

  it('knowledge-types 为类型正本（ENTRY_TYPE_MAP 运行时可导）', async () => {
    const mod = await import('../knowledge-types.js');
    expect((mod as any).ENTRY_TYPE_MAP).toMatchObject({ pattern: 'guideline', failure: 'pitfall' });
  });
});

describe('knowledge-service 拆分：门面公共面不破坏（#669）', () => {
  it('门面保留全部既有运行时导出', async () => {
    const mod = await import('../knowledge-service.js');
    expect(typeof mod.KnowledgeService).toBe('function');
    expect(mod.knowledgeService).toBeInstanceOf(mod.KnowledgeService);
    expect(mod.INJECT_TOKEN_BUDGET).toBe(927);
    expect(typeof mod.KNOWLEDGE_QUERY_GUIDANCE).toBe('string');
    expect(typeof mod.writeTrendData).toBe('function');
    expect(typeof mod.validateKnowledgeForm).toBe('function');
  });

  it('prototype 方法面不变（恰好 33 个，含 TS private 运行时方法）', async () => {
    const { KnowledgeService } = await import('../knowledge-service.js');
    const methods = Object.getOwnPropertyNames(KnowledgeService.prototype)
      .filter(m => m !== 'constructor');
    expect(methods).toHaveLength(33);
  });
});

describe('knowledge-service 拆分：门面瘦身 + 死副本清除（#669）', () => {
  it('knowledge-service.ts 不再单文件巨型化（< 500 行）', () => {
    const source = fs.readFileSync(path.join(MODULE_DIR, 'knowledge-service.ts'), 'utf-8');
    expect(source.split('\n').length).toBeLessThan(500);
  });

  it('历史拆分遗留的死副本已删除（零 importer 的漂移拷贝）', () => {
    for (const dead of ['knowledge-search-helpers.ts', 'knowledge-data-layer.ts', 'knowledge-forms.ts']) {
      expect(fs.existsSync(path.join(MODULE_DIR, dead)), dead).toBe(false);
    }
  });
});
