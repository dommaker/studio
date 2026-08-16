/**
 * PR Creation Phase Hooks
 *
 * PR 创建 → ReviewGate → SecurityGate → ContractGate
 */

import { logger } from '../../utils/logger';
import type { HookDefinition } from '@dommaker/harness';

/** PR 创建后：门禁检查（待 GateChecker 全量接入） */
export async function afterPrCreated(): Promise<void> {
  logger.info('[Harness] afterPrCreated hook executed');
}

/** 导出即注册（C1）：hook 函数与 HookDefinition 同文件导出 */
export const prHookDefinitions: HookDefinition[] = [
  {
    name: 'afterPrCreated',
    phase: 'after',
    execute: async () => {
      await afterPrCreated();
      return { passed: true };
    },
  },
];
