/**
 * Agent Execution Phase Hooks
 */
import type { ConstraintContext } from '@dommaker/harness';
export declare function beforeAgentExecute(ctx: ConstraintContext & {
    hasWorktree?: boolean;
    worktreePath?: string;
}): Promise<void>;
export declare function buildAgentConstraintPrompt(ctx: ConstraintContext): string;
export declare function afterAgentComplete(params?: {
    executionId?: string;
    success?: boolean;
    sessionCount?: number;
}): Promise<void>;
//# sourceMappingURL=agent.hooks.d.ts.map