// per-WU-type COMPLETE 收割注册表单测（#542）：表驱动直测 harvestCompletionMetadata，
// 不构造 AgentLoop、不 mock 执行器（对称 step-guards/completion-gates 的可测试性契约）。
// 覆盖：六种收割分支逐 type 命中/落空、plan 复用 analysis 契约、inspection 变体标记、
// 未注册 type 空获、单个收割器抛错不阻断其余收割器（失败语义决议）。
import { describe, it, expect, afterEach } from 'vitest';
import {
  harvestCompletionMetadata,
  COMPLETION_HARVEST_REGISTRY,
  type CompletionHarvestContext,
} from '../completion-harvest';
import type { WorkUnitMetadata } from '../../../workunit/workunit.service.js';

function ctx(overrides: Partial<CompletionHarvestContext> = {}): CompletionHarvestContext {
  return { wuId: 'wu-1', wuType: 'task', metadata: {} as WorkUnitMetadata, ...overrides };
}

describe('harvestCompletionMetadata', () => {
  it.each([
    ['task'], ['feature'], ['bug'], ['unknown-type'],
  ])('未注册 type（%s）→ 空 updates', (wuType) => {
    expect(harvestCompletionMetadata('REVIEW_RESULT: {"verdict":"pass"}', ctx({ wuType }))).toEqual({});
  });

  describe('review', () => {
    it.each([
      {
        name: 'REVIEW_RESULT pass 行 → reviewReport.approved=true',
        text: '评审完毕\nREVIEW_RESULT: {"verdict":"pass","summary":"LGTM"}',
        expected: { reviewReport: { approved: true, reason: 'LGTM', issues: undefined } },
      },
      {
        name: 'REVIEW_RESULT reject 行 → reviewReport.approved=false',
        text: 'REVIEW_RESULT: {"verdict":"reject","summary":"缺测试"}',
        expected: { reviewReport: { approved: false, reason: '缺测试', issues: undefined } },
      },
      {
        name: '无 REVIEW_RESULT 且无 verdict 关键词 → 空（转人工，不误拒）',
        text: '随便一段没有结论的输出',
        expected: {},
      },
    ])('$name', ({ text, expected }) => {
      expect(harvestCompletionMetadata(text, ctx({ wuType: 'review' }))).toEqual(expected);
    });
  });

  describe.each(['analysis', 'plan'])('%s（plan 复用 analysis 契约）', (wuType) => {
    it.each([
      {
        name: 'TASK: 拆分行 → analysisTasks',
        text: '分析结论\nTASK: 拆出登录接口\nTASK: 补齐鉴权测试',
        metadata: {},
        expected: { analysisTasks: ['拆出登录接口', '补齐鉴权测试'] },
      },
      {
        name: 'FOG:+DESTINATION: → analysisFog + analysisDestination',
        text: 'DESTINATION: 上线支付\nFOG: 用哪家通道？\nFOG: 额度怎么定？',
        metadata: {},
        expected: { analysisFog: ['用哪家通道？', '额度怎么定？'], analysisDestination: '上线支付' },
      },
      {
        name: '有 FOG 无 DESTINATION → 只落 analysisFog（destination 不单独落档）',
        text: 'FOG: 用哪家通道？',
        metadata: {},
        expected: { analysisFog: ['用哪家通道？'] },
      },
      {
        name: 'inspection=true + OPPORTUNITY: 行 → opportunities（opp-N/pending）',
        text: 'OPPORTUNITY: {"problem":"构建慢","suggestion":"开缓存","estimate":"1d"}',
        metadata: { inspection: true },
        expected: {
          opportunities: [{ id: 'opp-1', problem: '构建慢', suggestion: '开缓存', estimate: '1d', status: 'pending' }],
        },
      },
      {
        name: '无 inspection 标记 → OPPORTUNITY 行不收割',
        text: 'OPPORTUNITY: {"problem":"构建慢","suggestion":"开缓存"}',
        metadata: {},
        expected: {},
      },
      {
        name: '无任何协议行 → 空（不阻断完成）',
        text: '就是一段普通结论文本',
        metadata: {},
        expected: {},
      },
      {
        name: '三类协议行同现 → 全部落档',
        text: 'TASK: 拆接口\nFOG: 通道选型？\nOPPORTUNITY: {"problem":"构建慢","suggestion":"开缓存"}',
        metadata: { inspection: true },
        expected: {
          analysisTasks: ['拆接口'],
          analysisFog: ['通道选型？'],
          opportunities: [{ id: 'opp-1', problem: '构建慢', suggestion: '开缓存', status: 'pending' }],
        },
      },
    ])('$name', ({ text, metadata, expected }) => {
      expect(harvestCompletionMetadata(text, ctx({ wuType, metadata: metadata as WorkUnitMetadata }))).toEqual(expected);
    });
  });

  describe('decision', () => {
    it.each([
      {
        name: '## 结论摘要 段 → decisionSuggestion',
        text: '分析过程……\n## 结论摘要\n建议走方案 A。\n## 其他\n无关内容',
        expected: { decisionSuggestion: '建议走方案 A。' },
      },
      {
        name: '无结论摘要段 → 空（确认弹窗空手填）',
        text: '没有任何标题的正文',
        expected: {},
      },
    ])('$name', ({ text, expected }) => {
      expect(harvestCompletionMetadata(text, ctx({ wuType: 'decision' }))).toEqual(expected);
    });
  });

  describe('spec', () => {
    it.each([
      {
        name: 'TASK: 物化行（含 AC/BLOCKEDBY/LEG 段）→ specTasks',
        text: 'TASK: 登录接口 | AC: 返回 token | BLOCKEDBY: wu-0, wu-1 | LEG: api',
        expected: { specTasks: [{ title: '登录接口', ac: ['返回 token'], blockedBy: ['wu-0', 'wu-1'], leg: 'api' }] },
      },
      {
        name: '无 TASK 行 → 空（不阻断完成）',
        text: '普通 spec 结论文本',
        expected: {},
      },
    ])('$name', ({ text, expected }) => {
      expect(harvestCompletionMetadata(text, ctx({ wuType: 'spec' }))).toEqual(expected);
    });
  });

  describe('失败语义：单个收割器抛错不阻断收割链', () => {
    afterEach(() => {
      delete COMPLETION_HARVEST_REGISTRY['throwing-type'];
    });

    it('抛错的收割器被跳过，同 type 其余收割器照常收割', () => {
      COMPLETION_HARVEST_REGISTRY['throwing-type'] = [
        () => { throw new Error('boom'); },
        () => ({ analysisTasks: ['幸存'] }),
      ];
      expect(harvestCompletionMetadata('whatever', ctx({ wuType: 'throwing-type' })))
        .toEqual({ analysisTasks: ['幸存'] });
    });
  });

  it('新 type 收割 = 注册一行（注册表驱动，无 type 分支）', () => {
    COMPLETION_HARVEST_REGISTRY['ad-hoc-type'] = [(text) => text.includes('X') ? { customField: 1 } : {}];
    try {
      expect(harvestCompletionMetadata('has X', ctx({ wuType: 'ad-hoc-type' }))).toEqual({ customField: 1 });
      expect(harvestCompletionMetadata('no marker', ctx({ wuType: 'ad-hoc-type' }))).toEqual({});
    } finally {
      delete COMPLETION_HARVEST_REGISTRY['ad-hoc-type'];
    }
  });
});
