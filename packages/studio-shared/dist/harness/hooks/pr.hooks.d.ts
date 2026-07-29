/**
 * PR Creation Phase Hooks
 *
 * PR 创建 → ReviewGate → SecurityGate → ContractGate
 */
/** PR 创建后：门禁检查（待 GateChecker 全量接入） */
export declare function afterPrCreated(): Promise<void>;
//# sourceMappingURL=pr.hooks.d.ts.map