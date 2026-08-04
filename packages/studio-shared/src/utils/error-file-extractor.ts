/**
 * Extract affected file paths from compiler/test error messages.
 *
 * Extracted from Pipeline integration-rollback.ts.
 * 3-layer pattern matching with priority:
 * 1. tsc exact: "src/foo.ts(10,5): error TS2345"
 * 2. test FAIL: "FAIL src/foo.test.ts"
 * 3. generic fallback: any .ts/.tsx path (only when layers 1+2 have no match)
 */

/**
 * Extract file paths from error output.
 * @param errorOutput Compiler or test error message
 * @returns Deduplicated list of affected file paths
 */
export function extractAffectedFiles(errorOutput: string): string[] {
  const files = new Set<string>();

  // Layer 1: tsc pattern — file.ts(line,col): error
  const tscMatches = errorOutput.matchAll(/(\S+\.ts)\(\d+,\d+\)/g);
  for (const m of tscMatches) {
    files.add(m[1]);
  }

  // Layer 2: test failure pattern — FAIL path/to/test.ts
  const testMatches = errorOutput.matchAll(/(?:FAIL|Error:)\s+(\S+\.test\.\S+)/g);
  for (const m of testMatches) {
    files.add(m[1]);
  }

  // Layer 3: generic fallback — only when layers 1+2 found nothing
  if (files.size === 0) {
    const genericMatches = errorOutput.matchAll(/(\S+\.tsx?)(?:\s|$|:)/g);
    for (const m of genericMatches) {
      if (!m[1].includes('node_modules') && !m[1].includes('dist/')) {
        files.add(m[1]);
      }
    }
  }

  return [...files];
}
