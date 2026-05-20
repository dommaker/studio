/**
 * Role memory types — used by memory.service.ts
 */

/**
 * 角色记忆（JSON 字段，legacy 回退用）
 */
export interface RoleMemory {
  entries: RoleMemoryEntry[];
  lastUpdatedAt: Date;
  maxEntries: number;
}

/**
 * 角色记忆条目
 */
export interface RoleMemoryEntry {
  id: string;
  type: 'experience' | 'decision' | 'feedback' | 'learning';
  content: string;
  taskId?: string;
  importance: number;
  scope?: 'project' | 'global';
  createdAt: Date;
  lastAccessedAt: Date;
}
