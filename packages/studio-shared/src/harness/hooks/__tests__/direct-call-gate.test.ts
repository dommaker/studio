/**
 * 管线外直调 hook 的判定闸（#159 studio 随动的缺口修补）
 *
 * 背景：harness 的 HookPipeline 按**时机**执行（run('before') 跑所有 before hook），
 * 而 studio 的真实调用路径是按**名字**直调单个 hook 函数
 * （packages/studio-agent/src/services/runner-execution.ts 调 beforeAgentExecute）。
 * 判定只能在这条路径上另有一处读取点，否则 enabled / HARNESS_HOOK_DISABLE 配了不生效。
 *
 * 这组用例钉的就是「直调路径必须认声明表」——任何把判定层从直调出口上摘掉的改动都要红。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConstraintContext } from '@dommaker/harness';

vi.mock('@dommaker/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/harness')>();
  return { ...actual, checkBeforeExecution: vi.fn(async () => {}) };
});

const HOOK = 'beforeAgentExecute'; // 声明表里 enabled:true + blocking:true（→ block）
const WARN_HOOK = 'afterReview'; // 声明表里 enabled:true + blocking:false（→ warn）

const CTX: ConstraintContext = { operation: 'code_implementation', taskDescription: 'x' };

beforeEach(() => {
  delete process.env.HARNESS_HOOK_DISABLE;
});

afterEach(() => {
  delete process.env.HARNESS_HOOK_DISABLE;
  vi.restoreAllMocks();
});

describe('直调出口认声明表的 enabled', () => {
  it('HARNESS_HOOK_DISABLE 点名该 hook → 直调 beforeAgentExecute 不进实现体', async () => {
    process.env.HARNESS_HOOK_DISABLE = HOOK;
    const harness = await import('@dommaker/harness');
    const { beforeAgentExecute } = await import('../agent.hooks');

    await beforeAgentExecute(CTX);

    expect(harness.checkBeforeExecution).not.toHaveBeenCalled();
  });

  it('未禁用 → 直调确实进实现体（上一条不是恒绿的空转闸）', async () => {
    const harness = await import('@dommaker/harness');
    const { beforeAgentExecute } = await import('../agent.hooks');

    await beforeAgentExecute(CTX);

    expect(harness.checkBeforeExecution).toHaveBeenCalledTimes(1);
  });
});

describe('runHook 按声明表分派错误策略', () => {
  it('enabled=false（env 覆盖）→ 实现体一次都不跑', async () => {
    process.env.HARNESS_HOOK_DISABLE = HOOK;
    const { runHook } = await import('../config');
    const body = vi.fn(async () => {});

    await runHook(HOOK, body);

    expect(body).not.toHaveBeenCalled();
  });

  it("block 声明：实现体抛错 → 向调用方抛出", async () => {
    const { runHook } = await import('../config');
    const boom = vi.fn(async () => {
      throw new Error('iron-law violated');
    });

    await expect(runHook(HOOK, boom)).rejects.toThrow('iron-law violated');
    expect(boom).toHaveBeenCalledTimes(1);
  });

  it("warn 声明：实现体抛错 → 吞掉并记一条警告，不向调用方抛出", async () => {
    const { runHook } = await import('../config');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boom = vi.fn(async () => {
      throw new Error('trace write failed');
    });

    await expect(runHook(WARN_HOOK, boom)).resolves.toBeUndefined();
    expect(boom).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(WARN_HOOK), expect.anything());
  });

  it('未注册名 → 按声明表缺省（disabled + warn）跳过，不跑实现体', async () => {
    const { runHook } = await import('../config');
    const body = vi.fn(async () => {});

    await runHook('no_such_hook', body);

    expect(body).not.toHaveBeenCalled();
  });
});

describe('声明单点：注册表有效值 ≡ 声明表', () => {
  it('逐名对撞（registerAll 填充的 EffectiveHook 与直调读的是同一份值）', async () => {
    const { HookRegistry } = await import('@dommaker/harness');
    const { getAllHookConfigs } = await import('../config');
    const { registerAllHooks } = await import('../register');

    const registry = new HookRegistry();
    registerAllHooks(registry);

    for (const declared of getAllHookConfigs()) {
      const effective = registry.get(declared.name);
      expect(effective, `${declared.name} 未注册`).toBeDefined();
      expect({ enabled: effective!.enabled, errorStrategy: effective!.errorStrategy }).toEqual({
        enabled: declared.enabled,
        errorStrategy: declared.errorStrategy,
      });
    }
  });
});
