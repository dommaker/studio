// ── 内置数据播种 ──
// P2-a：自 apps/api/src/index.ts 拆出。best-effort：失败只 log，不阻断启动。
import { logger } from '@dommaker/studio-shared';

export async function seedBuiltinSkillsStep(): Promise<void> {
  // #223：内置 skill 库首启 seed——正本随 @dommaker/studio-skill 包分发（packages/studio-skill/skills/），
  // 启动时同步进 SKILLS_DIR（缺→拷/未改→升级/无台账且一致→收养（#225）/用户改过或无台账不一致→不动），有变更则重生成 MANIFEST。
  // best-effort：失败只 log，不阻断启动。
  try {
    const { seedBuiltinSkills } = await import('@dommaker/studio-skill');
    const seeded = seedBuiltinSkills();
    if (seeded.copied.length || seeded.upgraded.length) {
      const { generateManifest } = await import('../modules/skills/index.js');
      generateManifest();
    }
    logger.info('[Skills] Builtin seed done', {
      copied: seeded.copied.length, upgraded: seeded.upgraded.length,
      skippedUserModified: seeded.skippedUserModified.length, skippedLegacy: seeded.skippedLegacy.length,
      adopted: seeded.adopted.length,
      errors: seeded.errors.length ? seeded.errors : undefined,
    });
  } catch (e) { logger.warn('[Skills] Builtin seed failed (non-blocking)', { error: String(e) }); }
}
