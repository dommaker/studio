/**
 * 权限矩阵配置
 * 
 * MR-004: 定义各角色的操作权限
 */

/**
 * 权限矩阵
 * 
 * Key: 操作名称
 * Value: 允许的角色列表
 */
export const PERMISSION_MATRIX: Record<string, string[]> = {
  // 会议操作
  create_meeting: ['CEO', 'Tech Lead', 'PM', 'Architect'],
  invite_role: ['CEO', 'Tech Lead', 'PM', 'Architect'],
  end_meeting: ['CEO', 'Tech Lead'],
  force_decision: ['CEO', 'Tech Lead'],
  
  // 纪要操作
  view_minutes: ['CEO', 'Tech Lead', 'PM', 'Developer', 'QA', 'Architect'],
  view_sensitive_minutes: ['CEO', 'Tech Lead'],
};

/**
 * 角色层级
 * 
 * L4 最高权限，L1 最低权限
 */
export const ROLE_LEVELS: Record<string, number> = {
  CEO: 4,
  TechLead: 3,
  Architect: 3,
  PM: 2,
  Developer: 1,
  QA: 1,
};

/**
 * 检查角色是否有权限执行操作
 * 
 * 🆕 SEC-003: 默认拒绝未定义的操作
 */
export function hasPermission(roleName: string, operation: string): boolean {
  const allowedRoles = PERMISSION_MATRIX[operation];
  if (!allowedRoles) {
    // SEC-003: 未定义的操作，默认拒绝
    return false;
  }
  
  // 角色名匹配（考虑不同的命名格式）
  const normalizedRoleName = roleName.replace(/[-_]/g, '').replace(/\s+/g, '');
  const normalizedAllowedRoles = allowedRoles.map(r => r.replace(/[-_]/g, '').replace(/\s+/g, ''));
  
  return normalizedAllowedRoles.some(r => 
    r.toLowerCase() === normalizedRoleName.toLowerCase()
  );
}

/**
 * 获取操作需要的角色列表
 */
export function getRequiredRoles(operation: string): string[] {
  return PERMISSION_MATRIX[operation] || [];
}

/**
 * 获取角色的权限级别
 */
export function getRoleLevel(roleName: string): number {
  const normalizedRoleName = roleName.replace(/[-_]/g, '').replace(/\s+/g, '');
  
  for (const [name, level] of Object.entries(ROLE_LEVELS)) {
    if (name.toLowerCase() === normalizedRoleName.toLowerCase()) {
      return level;
    }
  }
  
  return 1; // 默认最低权限
}