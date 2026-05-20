// studio-capability 入口

export { CapabilityService } from './services/capability.service.js';
export { CompanySkillService, companySkillService } from './services/company-skill.service.js';

export type {
  CreateCompanySkillInput,
  UpdateCompanySkillInput,
  ListCompanySkillsQuery,
} from './services/company-skill.service.js';

// 从 runtime 迁移的公司 MCP 资源池
export * from './services/company-mcp-pool';