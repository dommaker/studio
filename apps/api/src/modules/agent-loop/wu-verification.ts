/** 兼容出口；独立实现已下沉 core/wu-verification（ARCH-02）。 */
export {
  CODE_WORKTREE_TYPES,
  VERIFY_COMMAND_TIMEOUT_MS,
  VERIFY_FAIL_TAIL_CHARS,
  extractExecOutputTail,
  resolveVerifyCommands,
  runWuVerification,
} from '../../core/wu-verification.js';
export type { VerificationWorkUnit, WuVerifyOutcome } from '../../core/wu-verification.js';
