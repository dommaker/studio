/**
 * skills 模块公共出口（P2-c 立界，scripts/p2c-public-surface.mjs 生成）
 *
 * 跨模块只允许 import 本文件（模块根）；深路径 import 由 eslint local/no-deep-module-import 拦截。
 * 公共面 = 生成时实际被模块外消费的符号；新增跨模块消费时在此补导出。
 */
export { generateManifest } from './manifest-generator.js';
export { loadManifest } from './manifest-loader.js';
export { getSkillReviewAdapter, submitSkillProposal } from './review-adapter.js';
export { skillLoaderService } from './skill-loader.js';
export { parseSkillHintsFromScope, selectSkillsForInjection } from './skill-selector.js';
export { skillStore } from './skill-store.js';
export { initSkillUsageScan } from './skill-usage-scan.js';
