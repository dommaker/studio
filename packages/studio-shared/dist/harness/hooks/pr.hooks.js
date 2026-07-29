/**
 * PR Creation Phase Hooks
 *
 * PR 创建 → ReviewGate → SecurityGate → ContractGate
 */
import { logger } from '../../utils/logger';
/** PR 创建后：门禁检查（待 GateChecker 全量接入） */
export async function afterPrCreated() {
    logger.info('[Harness] afterPrCreated hook executed');
}
//# sourceMappingURL=pr.hooks.js.map