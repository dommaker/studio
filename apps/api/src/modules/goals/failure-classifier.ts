/**
 * Failure classifier — pattern matching on error messages
 *
 * Classifies execution failures into:
 * - 'retryable': code bugs, env issues (agent can fix)
 * - 'not-retryable': approach infeasibility (needs human)
 * - 'unknown': unrecognized (needs LLM diagnosis after retries exhaust)
 */

export type FailureClass = 'retryable' | 'not-retryable' | 'unknown';

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

  for (const pattern of RETRYABLE_PATTERNS) {
    if (pattern.test(error)) return 'retryable';
  }

  return 'unknown';
}
