/**
 * 考核指标配置
 * 各角色类型的月度考核指标
 */

export interface MetricConfig {
  name: string;
  weight: number;
  target: number;
  unit: string;
  dataSource: string;
  calculateScore: (value: number, target: number) => number;
}

// 分数计算函数：根据达成率计算 0-100 分
function calculateAchievementScore(value: number, target: number): number {
  const achievementRate = value / target;
  if (achievementRate >= 1.2) return 100; // 超预期 20%
  if (achievementRate >= 1.0) return 85 + (achievementRate - 1) * 15 * 5; // 85-100
  if (achievementRate >= 0.8) return 70 + (achievementRate - 0.8) * 15 * 5; // 70-85
  if (achievementRate >= 0.6) return 50 + (achievementRate - 0.6) * 20 * 5; // 50-70
  return achievementRate * 83.3; // 0-50
}

// 反向指标：越小越好（如 bug 率、返工率）
function calculateReverseScore(value: number, target: number): number {
  // target 是上限，value 越小越好
  if (value <= target * 0.5) return 100; // 远低于目标
  if (value <= target) return 85 + (target - value) / target * 15;
  if (value <= target * 1.5) return 70 - (value - target) / target * 15;
  if (value <= target * 2) return 50 - (value - target * 1.5) / target * 20;
  return 30; // 严重超标
}

// ========== 角色考核指标配置 ==========

export const ROLE_METRICS_CONFIG: Record<string, MetricConfig[]> = {
  reviewer: [
    {
      name: '审核数量',
      weight: 0.3,
      target: 20,
      unit: '次',
      dataSource: 'reviews.count',
      calculateScore: calculateAchievementScore,
    },
    {
      name: '问题检出率',
      weight: 0.4,
      target: 80,
      unit: '%',
      dataSource: 'reviews.detectionRate',
      calculateScore: calculateAchievementScore,
    },
    {
      name: '审核效率',
      weight: 0.2,
      target: 2,
      unit: '小时',
      dataSource: 'reviews.avgTime',
      calculateScore: calculateReverseScore, // 时间越短越好
    },
    {
      name: '封还准确率',
      weight: 0.1,
      target: 10,
      unit: '%',
      dataSource: 'reviews.rejectionAccuracy',
      calculateScore: calculateReverseScore, // 申诉成功率越低越好
    },
  ],

  strategy_lead: [
    {
      name: '方案数量',
      weight: 0.2,
      target: 5,
      unit: '个',
      dataSource: 'documents.count',
      calculateScore: calculateAchievementScore,
    },
    {
      name: '方案通过率',
      weight: 0.4,
      target: 70,
      unit: '%',
      dataSource: 'documents.passRate',
      calculateScore: calculateAchievementScore,
    },
    {
      name: '方案质量',
      weight: 0.3,
      target: 4.0,
      unit: '分',
      dataSource: 'reviews.avgScore',
      calculateScore: calculateAchievementScore,
    },
    {
      name: '返工率',
      weight: 0.1,
      target: 20,
      unit: '%',
      dataSource: 'documents.reworkRate',
      calculateScore: calculateReverseScore, // 返工率越低越好
    },
  ],

  tech_lead: [
    {
      name: '项目完成率',
      weight: 0.3,
      target: 90,
      unit: '%',
      dataSource: 'tasks.completionRate',
      calculateScore: calculateAchievementScore,
    },
    {
      name: '决策质量',
      weight: 0.3,
      target: 5,
      unit: '%',
      dataSource: 'decisions.errorRate',
      calculateScore: calculateReverseScore, // 失误率越低越好
    },
    {
      name: '团队满意度',
      weight: 0.2,
      target: 4.0,
      unit: '分',
      dataSource: 'reviews.avgScore',
      calculateScore: calculateAchievementScore,
    },
    {
      name: '资源利用率',
      weight: 0.2,
      target: 10,
      unit: '%',
      dataSource: 'economy.budgetVariance',
      calculateScore: calculateReverseScore, // 预算偏差越小越好
    },
  ],

  developer: [
    {
      name: '任务完成数',
      weight: 0.3,
      target: 15,
      unit: '个',
      dataSource: 'tasks.count',
      calculateScore: calculateAchievementScore,
    },
    {
      name: '代码质量',
      weight: 0.3,
      target: 5,
      unit: '%',
      dataSource: 'tasks.bugRate',
      calculateScore: calculateReverseScore, // bug 率越低越好
    },
    {
      name: '交付时效',
      weight: 0.2,
      target: 90,
      unit: '%',
      dataSource: 'tasks.onTimeRate',
      calculateScore: calculateAchievementScore,
    },
    {
      name: '审查通过率',
      weight: 0.2,
      target: 80,
      unit: '%',
      dataSource: 'reviews.passRate',
      calculateScore: calculateAchievementScore,
    },
  ],

  architect: [
    {
      name: '架构设计数量',
      weight: 0.2,
      target: 3,
      unit: '个',
      dataSource: 'documents.count',
      calculateScore: calculateAchievementScore,
    },
    {
      name: '架构评审通过率',
      weight: 0.3,
      target: 85,
      unit: '%',
      dataSource: 'reviews.passRate',
      calculateScore: calculateAchievementScore,
    },
    {
      name: '架构稳定性',
      weight: 0.3,
      target: 95,
      unit: '%',
      dataSource: 'tasks.stabilityRate',
      calculateScore: calculateAchievementScore,
    },
    {
      name: '技术选型准确性',
      weight: 0.2,
      target: 10,
      unit: '%',
      dataSource: 'decisions.techErrorRate',
      calculateScore: calculateReverseScore,
    },
  ],

  qa: [
    {
      name: '测试覆盖率',
      weight: 0.3,
      target: 80,
      unit: '%',
      dataSource: 'tasks.coverageRate',
      calculateScore: calculateAchievementScore,
    },
    {
      name: 'Bug 检出率',
      weight: 0.4,
      target: 90,
      unit: '%',
      dataSource: 'reviews.detectionRate',
      calculateScore: calculateAchievementScore,
    },
    {
      name: '测试效率',
      weight: 0.2,
      target: 4,
      unit: '小时',
      dataSource: 'tasks.avgTestTime',
      calculateScore: calculateReverseScore,
    },
    {
      name: '回归缺陷率',
      weight: 0.1,
      target: 5,
      unit: '%',
      dataSource: 'tasks.regressionRate',
      calculateScore: calculateReverseScore,
    },
  ],
};

// ========== 考核等级配置 ==========

export const GRADE_CONFIG: Record<string, {
  minScore: number;
  maxScore: number;
  qualityBonus: number;
  color: string;
  label: string;
}> = {
  S: { minScore: 95, maxScore: 100, qualityBonus: 0.30, color: 'gold', label: '卓越' },
  A: { minScore: 85, maxScore: 94, qualityBonus: 0.20, color: 'silver', label: '优秀' },
  B: { minScore: 70, maxScore: 84, qualityBonus: 0.05, color: 'bronze', label: '良好' },
  C: { minScore: 60, maxScore: 69, qualityBonus: 0, color: 'normal', label: '合格' },
  'C-': { minScore: 50, maxScore: 59, qualityBonus: -0.10, color: 'warning', label: '待改进' },
  D: { minScore: 0, maxScore: 49, qualityBonus: -0.20, color: 'danger', label: '不合格' },
};

// ========== 考核类型配置 ==========

export const ASSESSMENT_TYPE_CONFIG = {
  monthly: {
    name: '月考',
    periodFormat: 'YYYY-MM',
    affects: ['qualityBonus'],
    description: '每月考核，影响质量分',
  },
  quarterly: {
    name: '季度考',
    periodFormat: 'YYYY-Q1',
    affects: ['qualityBonus', 'salaryChange'],
    description: '每季度考核，影响质量分和工资',
  },
  annual: {
    name: '年度考',
    periodFormat: 'YYYY',
    affects: ['qualityBonus', 'salaryChange', 'levelChange'],
    description: '每年考核，影响晋升/降级',
  },
};

/**
 * 根据分数判定等级
 */
export function determineGrade(score: number): string {
  if (score >= 95) return 'S';
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'C-';
  return 'D';
}

/**
 * 获取等级配置
 */
export function getGradeConfig(grade: string) {
  return GRADE_CONFIG[grade] || GRADE_CONFIG['C'];
}