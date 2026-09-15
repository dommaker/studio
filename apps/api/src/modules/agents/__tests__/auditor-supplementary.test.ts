/**
 * Supplementary test: AuditorService edge cases
 *
 * Verifies:
 * - circuitSuggestions variable is defined (catches ReferenceError)
 * - Empty edge cases
 */
import { describe, it, expect } from 'vitest';

describe('AuditorService supplementary edge cases', () => {
  it('circuitSuggestions is defined before usage', async () => {
    // This test catches the bug: circuitSuggestions is used at line 183
    // but never defined as a local variable, causing ReferenceError at runtime.
    // The fix is to define it: `const circuitSuggestions = await this.analyzeKnowledgeCircuit();`
    const { AuditorService } = await import('../auditor/auditor.service.js');

    // Check that the runAudit method body references circuitSuggestions
    const runAuditSrc = AuditorService.prototype.runAudit?.toString() || '';
    const hasVarDef = /\bconst\s+circuitSuggestions\b/.test(runAuditSrc);
    const hasRef = /\bcircuitSuggestions\b/.test(runAuditSrc);

    // If circuitSuggestions is referenced but not defined, that's a bug
    if (hasRef && !hasVarDef) {
      // Check if it's defined elsewhere (e.g., a let at function scope)
      const hasLetDef = /\blet\s+circuitSuggestions\b/.test(runAuditSrc);
      const isParam = runAuditSrc.includes('circuitSuggestions = ');
      if (!isParam) {
        // It must be defined somewhere — let, const, or this.circuitSuggestions
        const hasThisDef = runAuditSrc.includes('this.circuitSuggestions');
        expect(hasVarDef || hasLetDef || hasThisDef).toBe(true);
      }
    }
  });
});
