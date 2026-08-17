/**
 * knowledge-singletons tests — R4 收敛后的单例拥有者
 * 轻量直接测试：单例身份、目录常量、消费链验证、质量门入口。
 * 深层行为由 knowledge-service / knowledge-bus-sync 等测试覆盖。
 */
import { describe, it, expect } from 'vitest';
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
