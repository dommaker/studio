import { registerKnowledgeReviewAdapter } from '../modules/knowledge/review-adapter.js';

/** 启动时显式装配 Knowledge review adapter；重复注册沿用注册表后者生效语义。 */
export function registerKnowledgeAdapters(): void {
  registerKnowledgeReviewAdapter();
}
