/**
 * PMO 项目兼容 facade。领域模型、FileStore CRUD、publish 与文档查询分别由
 * model / project-repository / publish-project / project-documents 持有。
 */
import { getLinkedSDDs } from './project-documents.js';
import { projectRepository } from './project-repository.js';
import { publishProject } from './publish-project.js';

export * from './model.js';
export { generatePmoNumber } from './project-repository.js';
export { PLAN_TOKEN_BUDGET_DEFAULT, resolvePlanTokenBudget } from './publish-project.js';

export const projectService = {
  ...projectRepository,
  publish: publishProject,
  getLinkedSDDs,
};
