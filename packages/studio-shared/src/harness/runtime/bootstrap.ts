/**
 * Harness Runtime Bootstrap
 *
 * 启动时加载 .harness/config.yml，初始化 ConstraintChecker。
 * #562：业务 hook 注册与 HookPipeline 访问器随 hooks 层收缩删除，本文件只剩初始化。
 */

import { bootstrapHarness as harnessBootstrap } from '@dommaker/harness';
import type { HarnessBootstrap } from '@dommaker/harness';

let bootstrap: HarnessBootstrap | null = null;

/**
 * 初始化 harness 运行时
 * 应在 API 服务器启动时调用一次
 */
export async function bootstrapHarness(projectPath?: string): Promise<HarnessBootstrap> {
  if (bootstrap) return bootstrap;

  const root = projectPath || process.cwd();

  try {
    // 使用 harness bootstrap（异步加载配置，解决 S9）
    bootstrap = await harnessBootstrap(root);

    console.log(`[Harness] Bootstrap complete — project: ${root}`);
    return bootstrap;
  } catch (err) {
    console.warn('[Harness] Bootstrap failed:', (err as Error).message);
    // Fallback: 同步初始化
    const { bootstrapHarnessSync } = await import('@dommaker/harness');
    bootstrap = bootstrapHarnessSync(root);
    return bootstrap;
  }
}

/**
 * 获取已初始化的 harness 实例
 */
export function getHarness(): HarnessBootstrap | null {
  return bootstrap;
}

export function isHarnessInitialized(): boolean {
  return bootstrap !== null;
}
