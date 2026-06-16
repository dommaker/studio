/**
 * AC Group modelTier inheritance.
 *
 * Each acGroup should carry a modelTier so downstream routing (routeModel)
 * and step creation (createGoalFromChannelDoc) use the correct model.
 * When taskTier is set but a group has no modelTier, inherit from taskTier.
 */

export interface AcGroupWithTier {
  id: string;
  acs: string[];
  files?: string[];
  dependencies?: string[];
  modelTier?: string;
  modelTierReason?: string;
  [key: string]: unknown;
}

type ModelTier = 'fast' | 'standard' | 'premium';

const VALID_TIERS: ReadonlySet<string> = new Set(['fast', 'standard', 'premium']);

/**
 * Ensure each acGroup has modelTier set (inherit from taskTier if missing).
 * Mutates groups in place. Returns summary for logging.
 */
export function ensureModelTierInheritance(
  acGroups: AcGroupWithTier[],
  taskTier: string | undefined,
): { tier: string; acGroupCount: number; totalAcs: number; parallelizable: number; withDependencies: number; modelTiers: string } {
  if (taskTier && VALID_TIERS.has(taskTier)) {
    for (const g of acGroups) {
      if (!g.modelTier) {
        g.modelTier = taskTier as ModelTier;
      }
    }
  }

  return {
    tier: taskTier || 'unknown',
    acGroupCount: acGroups.length,
    totalAcs: acGroups.reduce((s, g) => s + g.acs.length, 0),
    parallelizable: acGroups.filter(g => !g.dependencies?.length).length,
    withDependencies: acGroups.filter(g => (g.dependencies?.length ?? 0) > 0).length,
    modelTiers: acGroups.map(g => `${g.id}:${g.modelTier || 'standard'}`).join(', '),
  };
}
