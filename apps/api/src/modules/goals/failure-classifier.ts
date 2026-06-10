/**
 * Failure classifier — pattern matching on error messages
 *
 * Classifies execution failures into:
 * - 'infrastructure': worktree lost, DB connection, service restart (auto-retry, bypass LLM)
 * - 'retryable': code bugs, env issues (agent can fix, MAX_RETRIES=3)
 * - 'not-retryable': approach infeasibility (needs human)
 * - 'unknown': unrecognized (needs LLM diagnosis as last resort)
 */

export type FailureClass = 'retryable' | 'not-retryable' | 'infrastructure' | 'unknown';
export type FailureAction = 'retry-execution' | 'mark-blocked' | 'triage-agent';

/** Infrastructure patterns — checked BEFORE retryable (e.g. worktree ENOENT beats generic ENOENT) */
const INFRASTRUCTURE_PATTERNS = [
  /worktree.*lost/i,
  /worktree.*ENOENT/i,
  /worktree.*missing/i,
  /DB.*connection/i,
  /database.*connection/i,
  /ECONNREFUSED/i,
  /service.*restart/i,
];

const RETRYABLE_PATTERNS = [
  /TypeError/i,
  /SyntaxError/i,
  /ReferenceError/i,
  /RangeError/i,
  /ENOENT/i,
  /EACCES/i,
  /EPERM/i,
  /Cannot find module/i,
  /Tests? failed/i,
  /Build failed/i,
  /exit code [1-9]/i,
  /segmentation fault/i,
  /out of memory/i,
  /ENOMEM/i,
  /timeout/i,
  /ETIMEDOUT/i,
];

const NOT_RETRYABLE_PATTERNS = [
  /approach.*infeasible/i,
  /infeasible.*approach/i,
  /does not exist/i,
  /not supported/i,
  /not possible/i,
  /cannot be implemented/i,
  /impossible/i,
  /no such API/i,
  /API.*does not exist/i,
  /feature.*removed/i,
  /deprecated.*removed/i,
];

export function classifyFailure(error: string): FailureClass {
  if (!error || error.trim().length === 0) return 'unknown';

  for (const pattern of NOT_RETRYABLE_PATTERNS) {
    if (pattern.test(error)) return 'not-retryable';
  }

  // Infrastructure before retryable — worktree ENOENT should not match generic ENOENT
  for (const pattern of INFRASTRUCTURE_PATTERNS) {
    if (pattern.test(error)) return 'infrastructure';
  }

  for (const pattern of RETRYABLE_PATTERNS) {
    if (pattern.test(error)) return 'retryable';
  }

  return 'unknown';
}

/**
 * Map failure class to deterministic routing action.
 *
 * - infrastructure → retry-execution (bypass LLM, transient infra issue)
 * - retryable      → retry-execution (existing MAX_RETRIES=3 logic)
 * - not-retryable  → mark-blocked (notify human)
 * - unknown        → triage-agent (LLM as last resort)
 */
export function classifyFailureAction(error: string): { action: FailureAction; failureClass: FailureClass } {
  const failureClass = classifyFailure(error);

  switch (failureClass) {
    case 'infrastructure':
      return { action: 'retry-execution', failureClass };
    case 'retryable':
      return { action: 'retry-execution', failureClass };
    case 'not-retryable':
      return { action: 'mark-blocked', failureClass };
    case 'unknown':
      return { action: 'triage-agent', failureClass };
  }
}
