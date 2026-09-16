/**
 * hooks/config + register 注册表闭环（A4：HookConfig 统一 {name,enabled,errorStrategy}）
 *
 * 覆盖：
 * - 声明表形状：全部 7 个注册 hook 有声明，errorStrategy ∈ {block, warn}（经 toErrorStrategy 映射）
 * - #159 判定委托管线：注册 = 定义 ↔ 声明表配对（有效值来自声明表），
 *   block/warn/enabled 行为经 harness HookPipeline 验证（原 runHook 自建判定层已拆除）
 * - HARNESS_HOOK_DISABLE 覆盖 enabled
 * - assertHookRegistryClosed：声明 ↔ 注册双向闭环（正例 + 缺失/冗余/重复三向负例）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assertHookRegistryClosed, HookRegistry, HookPipeline } from '@dommaker/harness';
import type { HookDefinition } from '@dommaker/harness';

import { getAllHookConfigs, getHookConfig } from '../config';
import { buildHookDefinitions, registerAllHooks } from '../register';

describe('HookConfig 声明表（{name,enabled,errorStrategy}）', () => {
  beforeEach(() => {
    process.env.HARNESS_HOOK_DISABLE = '';
  });

  afterEach(() => {
    delete process.env.HARNESS_HOOK_DISABLE;
  });

  it('全部 7 个注册 hook 均有声明，且 errorStrategy 为 block/warn 二值', () => {
    const configs = getAllHookConfigs();
    const defs = buildHookDefinitions();

    expect(configs.map(c => c.name).sort()).toEqual(defs.map(d => d.name).sort());
    expect(configs).toHaveLength(7);
    for (const c of configs) {
      expect(typeof c.enabled).toBe('boolean');
      expect(['block', 'warn']).toContain(c.errorStrategy);
    }
  });

  it('阻断语义映射：beforeAgentExecute / checkBeforeTaskComplete → block，其余 warn', () => {
    const byName = new Map(getAllHookConfigs().map(c => [c.name, c]));
    expect(byName.get('beforeAgentExecute')?.errorStrategy).toBe('block');
    expect(byName.get('checkBeforeTaskComplete')?.errorStrategy).toBe('block');
    for (const name of ['beforeGoalCreate', 'beforeAgentDispatch', 'afterAgentComplete', 'afterReview', 'afterPrCreated']) {
      expect(byName.get(name)?.errorStrategy).toBe('warn');
    }
  });

  it('HARNESS_HOOK_DISABLE 覆盖 enabled（未禁用保持启用）', () => {
    process.env.HARNESS_HOOK_DISABLE = 'beforeAgentDispatch';
    expect(getHookConfig('beforeAgentDispatch').enabled).toBe(false);
    expect(getHookConfig('beforeAgentExecute').enabled).toBe(true);
  });

  it('未知 hook 返回 disabled（不抛错）', () => {
    const cfg = getHookConfig('nonexistent_hook');
    expect(cfg).toMatchObject({ name: 'nonexistent_hook', enabled: false, errorStrategy: 'warn' });
  });
});

describe('#159 注册配对 + 管线判定（原 runHook 自建判定层的接替者）', () => {
  beforeEach(() => {
    process.env.HARNESS_HOOK_DISABLE = '';
  });

  afterEach(() => {
    delete process.env.HARNESS_HOOK_DISABLE;
  });

  it('registerAllHooks = 定义 ↔ 声明表配对：注册表有效值逐项等于声明表', () => {
    const registry = new HookRegistry();
    registerAllHooks(registry);

    expect(registry.size).toBe(7);
    const configByName = new Map(getAllHookConfigs().map(c => [c.name, c]));
    for (const hook of registry.listAll()) {
      const config = configByName.get(hook.name);
      expect(config).toBeDefined();
      expect(hook.enabled).toBe(config!.enabled);
      expect(hook.errorStrategy).toBe(config!.errorStrategy);
    }
  });

  it('block hook 失败 → 管线 passed=false 且 blockedBy 含该 hook（阻断口径住管线）', async () => {
    const registry = new HookRegistry();
    registry.register(
      { name: 't_block', phase: 'before', execute: async () => { throw new Error('test error'); } },
      { name: 't_block', enabled: true, errorStrategy: 'block' },
    );
    const pipeline = new HookPipeline(registry);
    const result = await pipeline.run('before', {});

    expect(result.passed).toBe(false);
    expect(result.blockedBy).toEqual(['t_block']);
  });

  it('block hook 失败停止后续 hook 执行', async () => {
    const second = vi.fn(async () => ({ passed: true }));
    const registry = new HookRegistry();
    registry.register(
      { name: 't_block1', phase: 'before', priority: 1, execute: async () => { throw new Error('boom'); } },
      { name: 't_block1', enabled: true, errorStrategy: 'block' },
    );
    registry.register(
      { name: 't_block2', phase: 'before', priority: 2, execute: second },
      { name: 't_block2', enabled: true, errorStrategy: 'warn' },
    );
    const pipeline = new HookPipeline(registry);
    await pipeline.run('before', {});

    expect(second).not.toHaveBeenCalled();
  });

  it('warn hook 失败 → 管线记录警告继续（passed=true，warnings 含该 hook）', async () => {
    const registry = new HookRegistry();
    registry.register(
      { name: 't_warn', phase: 'after', execute: async () => { throw new Error('non-blocking error'); } },
      { name: 't_warn', enabled: true, errorStrategy: 'warn' },
    );
    const second = vi.fn(async () => ({ passed: true }));
    registry.register(
      { name: 't_warn_next', phase: 'after', priority: 2, execute: second },
      { name: 't_warn_next', enabled: true, errorStrategy: 'warn' },
    );
    const pipeline = new HookPipeline(registry);
    const result = await pipeline.run('after', {});

    expect(result.passed).toBe(true);
    expect(result.warnings).toEqual(['t_warn']);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('HARNESS_HOOK_DISABLE 禁用的 hook 不进入管线执行', async () => {
    process.env.HARNESS_HOOK_DISABLE =
      'beforeGoalCreate,beforeAgentDispatch,beforeAgentExecute,checkBeforeTaskComplete';
    const registry = new HookRegistry();
    registerAllHooks(registry);
    const pipeline = new HookPipeline(registry);
    const result = await pipeline.run('before', {});

    expect(result.records).toHaveLength(0);
    expect(registry.get('beforeAgentExecute')?.enabled).toBe(false);
    // 未禁用的 after phase hook 声明不受影响
    expect(registry.get('afterReview')?.enabled).toBe(true);
  });

  it('负例：定义缺声明表配对 → registerAll 抛错（不给表即拒注）', () => {
    const registry = new HookRegistry();
    const orphan: HookDefinition = {
      name: 'orphan_hook', phase: 'before', execute: async () => ({ passed: true }),
    };
    expect(() => registry.registerAll([orphan], getAllHookConfigs())).toThrow(/orphan_hook/);
  });

  it('负例：register 定义与配置名称不一致 → 抛错', () => {
    const registry = new HookRegistry();
    expect(() => registry.register(
      { name: 'hook_a', phase: 'before', execute: async () => ({ passed: true }) },
      { name: 'hook_b', enabled: true, errorStrategy: 'warn' },
    )).toThrow(/名称不一致/);
  });
});

describe('assertHookRegistryClosed — 声明 ↔ 注册双向闭环', () => {
  beforeEach(() => {
    process.env.HARNESS_HOOK_DISABLE = '';
  });

  afterEach(() => {
    delete process.env.HARNESS_HOOK_DISABLE;
  });

  it('C1 导出即注册：定义由各 hook 模块导出、聚合无手工清单', async () => {
    const goal = await import('../goal.hooks');
    const agent = await import('../agent.hooks');
    const completion = await import('../completion.hooks');
    const pr = await import('../pr.hooks');

    const moduleDefs = [
      ...goal.goalHookDefinitions,
      ...agent.agentHookDefinitions,
      ...completion.completionHookDefinitions,
      ...pr.prHookDefinitions,
    ];
    const moduleNames = moduleDefs.map(d => d.name).sort();
    expect(moduleNames).toEqual([
      'afterAgentComplete', 'afterPrCreated', 'afterReview',
      'beforeAgentDispatch', 'beforeAgentExecute', 'beforeGoalCreate', 'checkBeforeTaskComplete',
    ]);
    // 注册聚合 = 模块导出并集（不再有 register.ts 手工清单）
    expect(buildHookDefinitions().map(d => d.name).sort()).toEqual(moduleNames);
  });

  it('正例：声明表与注册定义完全闭合', () => {
    expect(() => assertHookRegistryClosed(getAllHookConfigs(), buildHookDefinitions())).not.toThrow();
  });

  it('负例：声明引用未注册实现 → 抛错（死配置）', () => {
    const configs = [...getAllHookConfigs(), { name: 'phantom_hook', enabled: true, errorStrategy: 'warn' as const }];
    expect(() => assertHookRegistryClosed(configs, buildHookDefinitions())).toThrow(/phantom_hook/);
  });

  it('负例：注册无对应声明 → 抛错（死代码）', () => {
    const defs = [...buildHookDefinitions(), {
      name: 'unclaimed_hook', phase: 'before' as const,
      execute: async () => ({ passed: true }),
    }];
    expect(() => assertHookRegistryClosed(getAllHookConfigs(), defs)).toThrow(/unclaimed_hook/);
  });

  it('负例：重复声明 → 抛错', () => {
    const dup = getAllHookConfigs()[0];
    expect(() => assertHookRegistryClosed([dup, { ...dup }], buildHookDefinitions())).toThrow(/重复声明/);
  });
});
