/**
 * Hooks 管线集成测试
 *
 * 覆盖：Hook 配置管理、per-hook 开关、safeCallHook 行为
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
    process.env.HARNESS_HOOK_DISABLE = 'afterMeetingDecision,beforeAgentDispatch';
    const { getHookConfig } = await import('../../packages/studio-shared/src/harness/hooks/config.js');

    expect(getHookConfig('afterMeetingDecision').enabled).toBe(false);
    expect(getHookConfig('beforeAgentDispatch').enabled).toBe(false);
    expect(getHookConfig('beforeAgentExecute').enabled).toBe(true); // 未禁用的仍启用
  });

  it('不存在的 hook 返回 disabled', async () => {
    const { getHookConfig } = await import('../../packages/studio-shared/src/harness/hooks/config.js');
    const cfg = getHookConfig('nonexistent_hook');
    expect(cfg.enabled).toBe(false);
  });
});

describe('safeCallHook — 失败处理', () => {
  it('blocking hook 失败应抛异常', async () => {
    const { safeCallHook } = await import('../../packages/studio-shared/src/harness/hooks/config.js');

    await expect(
      safeCallHook('beforeAgentExecute', async () => { throw new Error('test error'); }),
    ).rejects.toThrow('test error');
  });

  it('non-blocking hook 失败应静默', async () => {
    const { safeCallHook } = await import('../../packages/studio-shared/src/harness/hooks/config.js');

    await expect(
      safeCallHook('afterAgentComplete', async () => { throw new Error('non-blocking error'); }),
    ).resolves.toBeUndefined();
  });

  it('禁用的 hook 不执行', async () => {
    process.env.HARNESS_HOOK_DISABLE = 'checkBeforeTaskComplete';
    const { safeCallHook } = await import('../../packages/studio-shared/src/harness/hooks/config.js');
    const fn = vi.fn();

    await safeCallHook('checkBeforeTaskComplete', fn);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('Hooks 覆盖率 — 所有阶段 hook 已定义', () => {
  it('5 个阶段 hook 文件都可导入', async () => {
    const hooks = await import('../../packages/studio-shared/src/harness/hooks/index.js');
    expect(hooks).toBeDefined();
    // 验证关键导出存在
    expect(typeof hooks.afterMeetingDecision).toBe('function');
    expect(typeof hooks.beforeAgentDispatch).toBe('function');
    expect(typeof hooks.beforeAgentExecute).toBe('function');
    expect(typeof hooks.checkBeforeTaskComplete).toBe('function');
    expect(typeof hooks.afterPrCreated).toBe('function');
  });

  it('每个阶段至少有一个导出的 hook 函数', async () => {
    const { afterMeetingDecision, afterRequirementsDoc } = await import('../../packages/studio-shared/src/harness/hooks/meeting.hooks.js');
    const { beforeGoalCreate, beforeAgentDispatch } = await import('../../packages/studio-shared/src/harness/hooks/goal.hooks.js');
    const { beforeAgentExecute, afterAgentComplete, buildAgentConstraintPrompt } = await import('../../packages/studio-shared/src/harness/hooks/agent.hooks.js');
    const { checkBeforeTaskComplete, afterReview } = await import('../../packages/studio-shared/src/harness/hooks/completion.hooks.js');
    const { afterPrCreated } = await import('../../packages/studio-shared/src/harness/hooks/pr.hooks.js');

    expect(typeof afterMeetingDecision).toBe('function');
    expect(typeof afterRequirementsDoc).toBe('function');
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
