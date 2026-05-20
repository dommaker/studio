/**
 * 角色推荐服务
 * 
 * MR-021: 根据议题关键词推荐合适的角色
 */

import { prisma } from '@dommaker/studio-prisma';
import {
  extractMatchingCategories,
  getRecommendedRolesByCategories,
  extractMatchedKeywords,
  CATEGORY_ROLES,
  KEYWORD_CATEGORIES,
} from '../config/topic-role-mapping.js';

export interface RecommendedRole {
  id: string;
  name: string;
  matchReason: string;
}

export interface RoleRecommendationResult {
  recommendedRoles: RecommendedRole[];
  topic: string;
  matchedKeywords: string[];
}

/**
 * 根据议题推荐角色
 */
export async function recommendRolesForTopic(
  topic: string,
  companyId: string
): Promise<RoleRecommendationResult> {
  const categories = extractMatchingCategories(topic);
  const roleNames = getRecommendedRolesByCategories(categories);
  
  const roles = await prisma.role.findMany({
    where: { companyId, name: { in: roleNames } },
    select: { id: true, name: true },
  });
  
  const recommendedRoles = roles.map(role => {
    const matchingCategories = categories.filter(cat => 
      CATEGORY_ROLES[cat]?.includes(role.name)
    );
    
    return {
      id: role.id,
      name: role.name,
      matchReason: matchingCategories.map(cat => 
        KEYWORD_CATEGORIES[cat]?.[0] || cat
      ).join(','),
    };
  });
  
  const matchedKeywords = extractMatchedKeywords(topic);
  
  return { recommendedRoles, topic, matchedKeywords };
}