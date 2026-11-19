import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scenarioBudgets } from '../thresholds.js';

describe('scenarioBudgets', () => {
  it('scale/browser 与 gate 共用 gate-thresholds.json，不另写硬编码预算', () => {
    const config = JSON.parse(readFileSync(fileURLToPath(new URL('../../gate-thresholds.json', import.meta.url)), 'utf8'));
    expect(scenarioBudgets).toEqual({
      readP50Ms: config.thresholds.readP50BudgetMs,
      readP95Ms: config.thresholds.readP95BudgetMs,
      writeP50Ms: config.thresholds.writeP50BudgetMs,
      writeP95Ms: config.thresholds.writeP95BudgetMs,
      sseP50Ms: config.thresholds.sseP50BudgetMs,
      sseP95Ms: config.thresholds.sseP95BudgetMs,
      lcpP50Ms: config.thresholds.lcpP50BudgetMs,
      lcpP95Ms: config.thresholds.lcpP95BudgetMs,
      inpP50Ms: config.thresholds.inpP50BudgetMs,
      inpP95Ms: config.thresholds.inpP95BudgetMs,
      browserHeapGrowthBytes: config.thresholds.browserHeapGrowthBytes,
      browserRetainedChannelKeys: config.thresholds.browserRetainedChannelKeys,
    });
  });
});
