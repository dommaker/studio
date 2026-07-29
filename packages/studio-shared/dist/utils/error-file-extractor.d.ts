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
export declare function extractAffectedFiles(errorOutput: string): string[];
//# sourceMappingURL=error-file-extractor.d.ts.map