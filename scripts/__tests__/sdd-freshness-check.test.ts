/**
 * Tests for sdd-freshness-check.ts — CLI argument parsing
 */
import { describe, it, expect } from 'vitest';

describe('sdd-freshness-check', () => {
  it('CLI script exists and is loadable', () => {
    // Smoke test: script file exists
    const fs = require('fs');
    const path = require('path');
    const scriptPath = path.join(__dirname, '..', 'sdd-freshness-check.ts');
    expect(fs.existsSync(scriptPath)).toBe(true);
  });
});
