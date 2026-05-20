/**
 * 议题-角色映射配置
 * 
 * MR-021: 定义议题关键词对应的推荐角色
 */

/**
 * 关键词分类
 */
export const KEYWORD_CATEGORIES: Record<string, string[]> = {
  architecture: ['架构', 'architecture', '设计', 'design', '系统设计', '技术方案'],
  performance: ['性能', 'performance', '优化', 'optimize', '响应时间', '吞吐量'],
  product: ['产品', 'product', '需求', 'requirement', '功能', 'feature', '用户'],
  testing: ['测试', 'test', 'QA', '质量', 'quality', '验收'],
  code_review: ['代码审查', 'code review', '代码', 'code', '重构', 'refactor'],
  release: ['发布', 'release', '上线', 'deploy', '部署', '版本'],
  security: ['安全', 'security', '权限', 'permission', '认证', 'auth'],
  design: ['设计', 'design', 'UI', '交互', 'UX'],
};

/**
 * 关键词分类对应的推荐角色
 */
export const CATEGORY_ROLES: Record<string, string[]> = {
  architecture: ['Architect', 'Tech Lead', 'CEO'],
  performance: ['Tech Lead', 'Developer'],
  product: ['PM', 'CEO'],
  testing: ['QA', 'Developer'],
  code_review: ['Tech Lead', 'Developer'],
  release: ['Tech Lead', 'PM', 'CEO'],
  security: ['Architect', 'Tech Lead'],
  design: ['Architect', 'PM'],
};

/**
 * 从议题中提取匹配的关键词分类
 */
export function extractMatchingCategories(topic: string): string[] {
  const categories: string[] = [];
  
  for (const [category, keywords] of Object.entries(KEYWORD_CATEGORIES)) {
    for (const keyword of keywords) {
      if (topic.toLowerCase().includes(keyword.toLowerCase())) {
        categories.push(category);
        break; // 每个分类只匹配一次
      }
    }
  }
  
  return categories;
}

/**
 * 根据匹配的分类获取推荐角色
 */
export function getRecommendedRolesByCategories(categories: string[]): string[] {
  const roles = new Set<string>();
  
  for (const category of categories) {
    const categoryRoles = CATEGORY_ROLES[category] || [];
    for (const role of categoryRoles) {
      roles.add(role);
    }
  }
  
  return Array.from(roles);
}

/**
 * 获取匹配的具体关键词
 */
export function extractMatchedKeywords(topic: string): string[] {
  const matchedKeywords: string[] = [];
  
  for (const keywords of Object.values(KEYWORD_CATEGORIES)) {
    for (const keyword of keywords) {
      if (topic.toLowerCase().includes(keyword.toLowerCase())) {
        matchedKeywords.push(keyword);
      }
    }
  }
  
  return matchedKeywords;
}