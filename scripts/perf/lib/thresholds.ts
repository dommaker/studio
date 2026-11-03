import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface ScenarioBudgets {
  readP50Ms: number;
  readP95Ms: number;
  writeP50Ms: number;
  writeP95Ms: number;
  sseP50Ms: number;
  sseP95Ms: number;
  lcpP50Ms: number;
  lcpP95Ms: number;
  inpP50Ms: number;
  inpP95Ms: number;
  browserHeapGrowthBytes: number;
  browserRetainedChannelKeys: number;
}

const path = fileURLToPath(new URL('../gate-thresholds.json', import.meta.url));
const config = JSON.parse(readFileSync(path, 'utf8')) as { thresholds: Record<string, unknown> };
function number(key: string): number {
  const value = config.thresholds[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`gate-thresholds 缺合法场景预算：${key}`);
  return value;
}

/** scale/browser 唯一预算来源；不得在各场景另写数值。 */
export const scenarioBudgets: ScenarioBudgets = {
  readP50Ms: number('readP50BudgetMs'),
  readP95Ms: number('readP95BudgetMs'),
  writeP50Ms: number('writeP50BudgetMs'),
  writeP95Ms: number('writeP95BudgetMs'),
  sseP50Ms: number('sseP50BudgetMs'),
  sseP95Ms: number('sseP95BudgetMs'),
  lcpP50Ms: number('lcpP50BudgetMs'),
  lcpP95Ms: number('lcpP95BudgetMs'),
  inpP50Ms: number('inpP50BudgetMs'),
  inpP95Ms: number('inpP95BudgetMs'),
  browserHeapGrowthBytes: number('browserHeapGrowthBytes'),
  browserRetainedChannelKeys: number('browserRetainedChannelKeys'),
};
