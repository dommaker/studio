/**
 * hooks/config + register 注册表闭环（A4：HookConfig 统一 {name,enabled,errorStrategy}）
 *
 * 覆盖：
 * - 声明表形状：全部 7 个注册 hook 有声明，errorStrategy ∈ {block, warn}（经 toErrorStrategy 映射）
 * - runHook：enabled 检查 + errorStrategy 执行（block 抛 / warn 吞 / 禁用跳过）
 * - HARNESS_HOOK_DISABLE 覆盖 enabled
 * - assertHookRegistryClosed：声明 ↔ 注册双向闭环（正例 + 缺失/冗余/重复三向负例）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assertHookRegistryClosed } from '@dommaker/harness';

import { getAllHookConfigs, getHookConfig, runHook } from '../config';
import { buildHookDefinitions } from '../register';

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

describe('runHook — errorStrategy 执行（safeCallHook 接替者）', () => {
  beforeEach(() => {
    process.env.HARNESS_HOOK_DISABLE = '';
  });

  afterEach(() => {
    delete process.env.HARNESS_HOOK_DISABLE;
  });

  it('block hook 失败抛异常', async () => {
    await expect(
      runHook('beforeAgentExecute', async () => { throw new Error('test error'); }),
    ).rejects.toThrow('test error');
  });

  it('warn hook 失败静默继续', async () => {
    await expect(
      runHook('afterAgentComplete', async () => { throw new Error('non-blocking error'); }),
    ).resolves.toBeUndefined();
  });

  it('warn hook 失败按 warn 口径记录警告（errorStrategy=warn 文案）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runHook('afterAgentComplete', async () => { throw new Error('boom'); });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toBe('[HarnessHook] afterAgentComplete failed (warn):');
      expect(warnSpy.mock.calls[0][1]).toBe('boom');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('禁用的 hook 不执行', async () => {
    process.env.HARNESS_HOOK_DISABLE = 'checkBeforeTaskComplete';
    const fn = vi.fn();
    await runHook('checkBeforeTaskComplete', fn);
    expect(fn).not.toHaveBeenCalled();
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
      name: 'unclaimed_hook', phase: 'before' as const, errorStrategy: 'warn' as const,
      execute: async () => ({ passed: true }),
    }];
    expect(() => assertHookRegistryClosed(getAllHookConfigs(), defs)).toThrow(/unclaimed_hook/);
  });

  it('负例：重复声明 → 抛错', () => {
    const dup = getAllHookConfigs()[0];
    expect(() => assertHookRegistryClosed([dup, { ...dup }], buildHookDefinitions())).toThrow(/重复声明/);
  });
});
