/**
 * knowledge-singletons tests — R4 收敛后的单例拥有者
 * 轻量直接测试：单例身份、目录常量、消费链验证、质量门入口。
 * 深层行为由 knowledge-service / knowledge-bus-sync 等测试覆盖。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  isVectorDbSyncing,
  ingestWithQualityGate,
} from '../knowledge-singletons.js';
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

  it('verifyConsumptionChain returns a boolean without throwing', async () => {
    await expect(verifyConsumptionChain()).resolves.toBeTypeOf('boolean');
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
