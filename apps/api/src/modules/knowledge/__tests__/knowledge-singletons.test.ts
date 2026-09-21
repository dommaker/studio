/**
 * knowledge-singletons tests — R4 收敛后的单例拥有者
 * 轻量直接测试：单例身份、目录常量、消费链验证、质量门入口。
 * 深层行为由 knowledge-service / knowledge-bus-sync 等测试覆盖。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import {
  UNIFIED_KNOWLEDGE_DIR,
  sharedStore,
  sharedLifecycle,
  sharedIngest,
  sharedQuery,
  sharedInjector,
  sharedLinter,
  verifyConsumptionChain,
  CONSUMPTION_PROBE_ENTRY_ID,
  isVectorDbSyncing,
  ingestWithQualityGate,
} from '../knowledge-singletons.js';
import { resolveStudioLogFile } from '../../../utils/studio-log-path.js';
import { readStudioEventsSince } from '../../../utils/studio-events-tail.js';
import { setSegmentMetricsSink, type SegmentMetricEvent } from '@dommaker/studio-shared/read-metrics';

describe('knowledge-singletons (R4)', () => {
  it('owns the unified knowledge dir under the studio data root', () => {
    // #219：数据根 = STUDIO_HOME（setup 隔离根）优先，缺省 ~/.studio
    const studioRoot = process.env.STUDIO_HOME || path.join(os.homedir(), '.studio');
    expect(UNIFIED_KNOWLEDGE_DIR).toBe(path.join(studioRoot, 'knowledge'));
  });

  it('exposes all six shared singletons wired to the same store', () => {
    for (const s of [sharedStore, sharedLifecycle, sharedIngest, sharedQuery, sharedInjector, sharedLinter]) {
      expect(s).toBeDefined();
    }
    // lifecycle/ingest/query 都挂在同一个 sharedStore 上（harness 对象持有 store 引用）
    expect((sharedLifecycle as any).store ?? (sharedIngest as any).store).toBeDefined();
  });

  it('isVectorDbSyncing starts as false', () => {
    expect(isVectorDbSyncing()).toBe(false);
  });

  it('verifyConsumptionChain 真走 recordReference 链：true 且 knowledge:consumption 事件落盘（#611 去假绿）', async () => {
    await expect(verifyConsumptionChain()).resolves.toBe(true);

    const eventsFile = resolveStudioLogFile('studio-events.jsonl');
    const events = await readStudioEventsSince({ file: eventsFile, sinceMs: Date.now() - 60_000 });
    const probeEvents = events.filter(e => {
      if (e.type !== 'knowledge:consumption') return false;
      try {
        const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
        return p?.entryId === CONSUMPTION_PROBE_ENTRY_ID;
      } catch { return false; }
    });
    expect(probeEvents.length).toBeGreaterThan(0);
  });

  it('verifyConsumptionChain：recordReference 静默返回 undefined（链断）→ false，不判绿', async () => {
    const spy = vi.spyOn(sharedLifecycle, 'recordReference').mockReturnValueOnce(undefined as any);
    try {
      await expect(verifyConsumptionChain()).resolves.toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('哨兵条目 maturity=archived：不进默认 list（不污染注入/查询面），get 可达', async () => {
    await verifyConsumptionChain();
    expect(sharedStore.get(CONSUMPTION_PROBE_ENTRY_ID)).toBeDefined();
    expect(sharedStore.list().some(e => e.id === CONSUMPTION_PROBE_ENTRY_ID)).toBe(false);
  });

  it('ingestWithQualityGate is the single quality-gate entry (function)', () => {
    expect(typeof ingestWithQualityGate).toBe('function');
  });
});

describe('knowledge-singletons harness 段计时包装（#411）', () => {
  let events: SegmentMetricEvent[];

  beforeEach(() => {
    events = [];
    setSegmentMetricsSink(e => events.push(e));
  });

  afterEach(() => {
    setSegmentMetricsSink(null);
  });

  it('store 方法包装：直通方法（getSnapshot）发 harness 段事件', () => {
    // 缺文件安全返回 undefined（不依赖库内容）
    expect(sharedStore.getSnapshot('2000-01-01')).toBeUndefined();
    expect(events.map(e => e.name)).toContain('FileKnowledgeStore.getSnapshot');
    const ev = events.find(e => e.name === 'FileKnowledgeStore.getSnapshot')!;
    expect(ev.kind).toBe('harness');
    expect(ev.ms).toBeGreaterThanOrEqual(0);
  });

  it('store 读方法不包 span：memo miss 穿透时长已计入读口 readParseMs，包了双重计入', () => {
    // 独有 filter → memo key 唯一 → 必 miss → load() 穿透 rawKnowledgeStore.list
    const filter = { tags: [`probe-${Date.now()}-${Math.random()}`] } as never;
    expect(sharedStore.list(filter)).toEqual([]);
    expect(events.map(e => e.name)).not.toContain('FileKnowledgeStore.list');
    expect(events.map(e => e.name)).not.toContain('FileKnowledgeStore.readIndex');
  });

  it('facade 方法包装：lifecycle.runDecayCycle 发事件，内嵌 store 调用被嵌套去重', () => {
    const changes = sharedLifecycle.runDecayCycle();
    expect(changes).toEqual([]);
    expect(events.map(e => e.name)).toEqual(['KnowledgeLifecycle.runDecayCycle']);
  });

  it('facade 方法包装：query.checkPromotion 等轻调用各自发事件', () => {
    expect(sharedLifecycle.checkPromotion('no-such-id')).toBeUndefined();
    expect(events.map(e => e.name)).toEqual(['KnowledgeLifecycle.checkPromotion']);
  });

  it('包装不丢 facade 语义：query.queryByMode / ingest 实例方法仍可用（sink 开启时）', () => {
    // 空库查询路径（不写盘、不触发向量同步）
    expect(sharedQuery.queryByMode('signal')).toEqual([]);
    const names = events.map(e => e.name);
    expect(names).toContain('KnowledgeQuery.queryByMode');
    // ingest 不直接调用（会触发向量同步计时器），只验证方法仍为函数
    expect(typeof sharedIngest.ingestEntry).toBe('function');
  });
});
