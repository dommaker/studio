/**
 * PR Creation Phase Hooks
 *
 * PR 创建 → ReviewGate → SecurityGate → ContractGate
 */

import { logger } from '../../utils/logger';

/** PR 创建后：门禁检查 */
export async function afterPrCreated(): Promise<void> {
  logger.info('[Harness] afterPrCreated hook executed');
  // Phase 4+: ReviewGate.check, SecurityGate.check, ContractGate.check
  // 等待 GateChecker Meeting 解耦后全量接入
}
