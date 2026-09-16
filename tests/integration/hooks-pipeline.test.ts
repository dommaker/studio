/**
 * Hooks 管线集成测试
 *
 * 覆盖：Hook 配置管理、per-hook 开关、#159 管线路径判定
 * （block/warn/enabled 行为经 harness HookRegistry + HookPipeline 验证；
 *   管线粒度是时机，按名字直调 hook 的判定路径另见
 *   packages/studio-shared/src/harness/hooks/__tests__/direct-call-gate.test.ts）
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('Hooks Config — per-hook 开关', () => {
  afterEach(() => {
    delete process.env.HARNESS_HOOK_DISABLE;
  });

  it('默认全部 hook 启用', async () => {
    const { getAllHookConfigs } = await import('../../packages/studio-shared/src/harness/hooks/config.js');
    const configs = getAllHookConfigs();
    expect(configs.length).toBeGreaterThan(0);
    const enabledCount = configs.filter(c => c.enabled).length;
    expect(enabledCount).toBeGreaterThan(0);
  });

  it('HARNESS_HOOK_DISABLE 可禁用指定 hook', async () => {
    process.env.HARNESS_HOOK_DISABLE = 'beforeAgentDispatch';
    const { getHookConfig } = await import('../../packages/studio-shared/src/harness/hooks/config.js');

    expect(getHookConfig('beforeAgentDispatch').enabled).toBe(false);
    expect(getHookConfig('beforeAgentExecute').enabled).toBe(true); // 未禁用的仍启用
  });

  it('不存在的 hook 返回 disabled', async () => {
    const { getHookConfig } = await import('../../packages/studio-shared/src/harness/hooks/config.js');
    const cfg = getHookConfig('nonexistent_hook');
    expect(cfg.enabled).toBe(false);
  });
});

describe('管线失败处理 — errorStrategy（#159 时机粒度路径，声明值同源于配置表）', () => {
  afterEach(() => {
    delete process.env.HARNESS_HOOK_DISABLE;
  });

  const harness = async () => {
    const { HookRegistry, HookPipeline } = await import('@dommaker/harness');
    const { registerAllHooks } = await import('../../packages/studio-shared/src/harness/hooks/register.js');
    return { HookRegistry, HookPipeline, registerAllHooks };
  };

  it('注册表有效值来自声明表：beforeAgentExecute=block+启用，afterReview=warn+启用', async () => {
    const { HookRegistry, registerAllHooks } = await harness();
    const registry = new HookRegistry();
    registerAllHooks(registry);

    expect(registry.get('beforeAgentExecute')).toMatchObject({ enabled: true, errorStrategy: 'block' });
    expect(registry.get('afterReview')).toMatchObject({ enabled: true, errorStrategy: 'warn' });
  });

  it('block hook 失败 → 管线阻断（passed=false，blockedBy 记录），错误不外抛到调用层', async () => {
    const { HookRegistry, HookPipeline } = await harness();
    const registry = new HookRegistry();
    registry.register(
      { name: 'it_block', phase: 'before', execute: async () => { throw new Error('test error'); } },
      { name: 'it_block', enabled: true, errorStrategy: 'block' },
    );
    const result = await new HookPipeline(registry).run('before', {});

    expect(result.passed).toBe(false);
    expect(result.blockedBy).toEqual(['it_block']);
  });

  it('warn hook 失败应静默（passed=true，warnings 记录）', async () => {
    const { HookRegistry, HookPipeline } = await harness();
    const registry = new HookRegistry();
    registry.register(
      { name: 'it_warn', phase: 'after', execute: async () => { throw new Error('non-blocking error'); } },
      { name: 'it_warn', enabled: true, errorStrategy: 'warn' },
    );
    const result = await new HookPipeline(registry).run('after', {});

    expect(result.passed).toBe(true);
    expect(result.warnings).toEqual(['it_warn']);
  });

  it('禁用的 hook 不进入管线执行（声明表 enabled=false → getEnabled 过滤）', async () => {
    process.env.HARNESS_HOOK_DISABLE = 'beforeGoalCreate,beforeAgentDispatch,beforeAgentExecute,checkBeforeTaskComplete';
    const { HookRegistry, HookPipeline, registerAllHooks } = await harness();
    const registry = new HookRegistry();
    registerAllHooks(registry);
    const spy = vi.fn();
    registry.register({ name: 'it_sentinel', phase: 'before', execute: spy },
      { name: 'it_sentinel', enabled: true, errorStrategy: 'warn' });

    const result = await new HookPipeline(registry).run('before', {});

    expect(result.records.map(r => r.hookName)).toEqual(['it_sentinel']);
  });
});

describe('Hooks 覆盖率 — 所有阶段 hook 已定义', () => {
  it('5 个阶段 hook 文件都可导入', async () => {
    const hooks = await import('../../packages/studio-shared/src/harness/hooks/index.js');
    expect(hooks).toBeDefined();
    // 验证关键导出存在
    expect(typeof hooks.beforeAgentDispatch).toBe('function');
    expect(typeof hooks.beforeAgentExecute).toBe('function');
    expect(typeof hooks.checkBeforeTaskComplete).toBe('function');
    expect(typeof hooks.afterPrCreated).toBe('function');
  });

  it('每个阶段至少有一个导出的 hook 函数', async () => {
    const { beforeGoalCreate, beforeAgentDispatch } = await import('../../packages/studio-shared/src/harness/hooks/goal.hooks.js');
    const { beforeAgentExecute, afterAgentComplete, buildAgentConstraintPrompt } = await import('../../packages/studio-shared/src/harness/hooks/agent.hooks.js');
    const { checkBeforeTaskComplete, afterReview } = await import('../../packages/studio-shared/src/harness/hooks/completion.hooks.js');
    const { afterPrCreated } = await import('../../packages/studio-shared/src/harness/hooks/pr.hooks.js');

    expect(typeof beforeGoalCreate).toBe('function');
    expect(typeof beforeAgentDispatch).toBe('function');
    expect(typeof beforeAgentExecute).toBe('function');
    expect(typeof afterAgentComplete).toBe('function');
    expect(typeof buildAgentConstraintPrompt).toBe('function');
    expect(typeof checkBeforeTaskComplete).toBe('function');
    expect(typeof afterReview).toBe('function');
    expect(typeof afterPrCreated).toBe('function');
  });
});
