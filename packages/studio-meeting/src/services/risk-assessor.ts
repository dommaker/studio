/**
 * 风险评估器
 *
 * 评估会议决策的执行风险，支持三级风险分级：
 * - 低风险：自动执行
 * - 中风险：自动执行 + 通知
 * - 高风险：等待用户确认
 */

// 敏感操作关键词
const HIGH_RISK_KEYWORDS = [
  '删除', 'delete', 'drop', 'remove',
  '数据库迁移', 'migration', 'schema change',
  '权限', 'permission', 'auth', 'admin',
  '生产环境', 'production', 'deploy',
];

const MEDIUM_RISK_KEYWORDS = [
  'API', 'endpoint', '接口变更',
  '重构', 'refactor',
  '依赖升级', 'upgrade', 'dependency',
];

export interface RiskAssessment {
  level: 'low' | 'medium' | 'high';
  score: number;  // 0-100
  reasons: string[];
  requiresConfirmation: boolean;
}

export interface DecisionLike {
  content: string;
  agreed?: boolean;
}

export interface TaskLike {
  content: string;
}

/**
 * 评估会议风险
 */
export function assessMeetingRisk(
  decisions: DecisionLike[],
  tasks: TaskLike[] = []
): RiskAssessment {
  let score = 0;
  const reasons: string[] = [];

  // 1. 共识度检查
  const agreementRatio = calculateAgreementRatio(decisions);
  if (agreementRatio < 0.6) {
    score += 40;
    reasons.push('共识度较低');
  } else if (agreementRatio < 0.8) {
    score += 15;
    reasons.push('存在分歧但达成共识');
  }

  // 2. 敏感关键词检查
  const allContent = [...decisions, ...tasks].map(d => d.content).join(' ');

  for (const keyword of HIGH_RISK_KEYWORDS) {
    if (allContent.toLowerCase().includes(keyword.toLowerCase())) {
      score += 30;
      reasons.push(`涉及敏感操作: ${keyword}`);
    }
  }

  for (const keyword of MEDIUM_RISK_KEYWORDS) {
    if (allContent.toLowerCase().includes(keyword.toLowerCase())) {
      score += 10;
      reasons.push(`需关注: ${keyword}`);
    }
  }

  // 3. 改动范围检查（基于任务数量估算）
  const estimatedFileCount = estimateFileCount(tasks);
  if (estimatedFileCount > 10) {
    score += 25;
    reasons.push(`改动范围大: 约 ${estimatedFileCount} 文件`);
  } else if (estimatedFileCount > 3) {
    score += 10;
    reasons.push(`改动范围中等: 约 ${estimatedFileCount} 文件`);
  }

  // 确定风险等级
  const level: RiskAssessment['level'] = score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';

  return {
    level,
    score,
    reasons,
    requiresConfirmation: level === 'high',
  };
}

/**
 * 计算共识度
 */
function calculateAgreementRatio(decisions: DecisionLike[]): number {
  if (decisions.length === 0) return 1.0;

  const agreedCount = decisions.filter(d => d.agreed !== false).length;
  return agreedCount / decisions.length;
}

/**
 * 估算文件改动数量
 */
function estimateFileCount(tasks: TaskLike[]): number {
  if (tasks.length === 0) return 1;

  // 简单估算：每个任务约涉及 1-3 个文件
  // 实际可以根据任务内容关键词做更精确估算
  let fileCount = 0;

  for (const task of tasks) {
    const content = task.content.toLowerCase();

    // 前端相关
    if (content.includes('页面') || content.includes('组件') || content.includes('ui')) {
      fileCount += 2;
    }
    // API 相关
    else if (content.includes('api') || content.includes('接口') || content.includes('路由')) {
      fileCount += 3;
    }
    // 数据库相关
    else if (content.includes('数据库') || content.includes('model') || content.includes('schema')) {
      fileCount += 4;
    }
    // 默认
    else {
      fileCount += 1;
    }
  }

  return fileCount;
}

/**
 * 风险等级描述
 */
export function getRiskLevelDescription(level: RiskAssessment['level']): string {
  switch (level) {
    case 'low':
      return '🟢 低风险';
    case 'medium':
      return '🟡 中风险';
    case 'high':
      return '🔴 高风险';
  }
}
