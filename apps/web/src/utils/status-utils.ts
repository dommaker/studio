/**
 * Unified status / role / stance utilities.
 *
 * Consolidates duplicate helpers previously scattered across pages.
 */

// ===================== Status Color =====================

const STATUS_COLORS: Record<string, string> = {
  // Execution / workflow statuses
  running: '#2196F3',
  succeeded: '#4CAF50',
  success: '#4CAF50',
  failed: '#F44336',
  failure: '#F44336',
  cancelled: '#9E9E9E',

  // PMO / project statuses
  active: '#2196F3',
  archived: '#9E9E9E',

  // Role statuses
  idle: '#10b981',
  working: '#00d4ff',
  waiting: '#f59e0b',
  offline: '#6b7280',
};

export function getStatusColor(status: string): string {
  return STATUS_COLORS[status] || '#9E9E9E';
}

// ===================== Status Text =====================

const STATUS_TEXT: Record<string, string> = {
  // Execution
  running: '🔵 运行中',
  succeeded: '✅ 成功',
  success: '✅ 成功',
  failed: '❌ 失败',
  failure: '❌ 失败',
  cancelled: '⏹ 已取消',

  // PMO
  active: '🔵 进行中',
  archived: '📚 已归档',

  // Role
  idle: '🟢 空闲',
  working: '🔵 工作中',
  waiting: '🟡 等待中',
  offline: '⚫ 离线',
};

export function getStatusText(status: string): string {
  return STATUS_TEXT[status] || status;
}

// ===================== Role Icon =====================

/**
 * Returns an emoji icon for a role type.
 * Handles both kebab-case ("tech-lead") and snake_case ("tech_lead").
 */
export function getRoleIcon(type?: string): string {
  if (!type) return '👤';
  // Normalise snake_case to kebab-case so both variants map to the same icon.
  const normalised = type.replace(/_/g, '-');

  const ICONS: Record<string, string> = {
    'developer': '👨‍💻',
    'reviewer': '🔍',
    'architect': '🏗️',
    'qa': '🧪',
    'tech-lead': '👤',
    'strategy-lead': '🧠',
    'designer': '🎨',
    'product-manager': '📊',
    'pm': '📊',
    'ceo': '👑',
  };

  return ICONS[normalised] || '👤';
}

// ===================== Stance Name =====================

const STANCE_NAMES: Record<string, string> = {
  supporter: '支持者',
  critic: '批判者',
  decider: '决策者',
  executor: '执行者',
  tester: '测试者',
  architect: '架构师',
  designer: '设计师',
  product: '产品经理',
};

export function getStanceName(stance?: string): string {
  if (!stance) return '参与者';
  return STANCE_NAMES[stance] || stance;
}
