/**
 * 公司 MCP 资源池管理
 * 
 * 功能：
 * 1. 公司 MCP CRUD
 * 2. 系统级 MCP 启用/禁用
 * 3. 角色权限控制
 * 4. 敏感信息管理
 */

import type { ContextSharer } from '@dommaker/studio-meeting';

// ==================== 类型定义 ====================

/**
 * MCP 来源
 */
export type MCPSource = 'system' | 'private';

/**
 * MCP 传输类型
 */
export type MCPTransport = 'stdio' | 'http' | 'websocket';

/**
 * MCP 状态
 */
export type MCPStatus = 'active' | 'inactive' | 'error';

/**
 * 系统级 MCP 模板
 */
export interface SystemMCP {
  id: string;
  name: string;
  key: string;
  description?: string;
  
  // 传输配置
  transport: MCPTransport;
  command?: string;       // stdio 命令
  args?: string[];        // 命令参数
  url?: string;           // http/websocket URL
  headers?: Record<string, string>;
  
  // 元数据
  isPublic: boolean;      // 是否对所有公司开放
  category?: string;
  tags?: string[];
  
  // 时间戳
  createdAt: string;
  updatedAt: string;
}

/**
 * 公司 MCP 资源
 */
export interface CompanyMCP {
  id: string;
  companyId: string;
  
  // 基本信息
  name: string;
  key: string;
  description?: string;
  
  // 来源
  source: MCPSource;
  systemMCPId?: string;   // 关联的系统级 MCP
  
  // MCP 配置（私有 MCP 或覆盖系统配置）
  transport: MCPTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;   // 环境变量（可能包含敏感信息）
  url?: string;
  headers?: Record<string, string>;
  
  // 权限控制
  enabled: boolean;
  allowedRoles?: string[];   // 允许访问的角色列表（空 = 所有角色）
  
  // 状态
  status: MCPStatus;
  lastError?: string;
  lastCheckedAt?: string;
  
  // 使用统计
  usageCount: number;
  lastUsedAt?: string;
  
  // 时间戳
  createdAt: string;
  updatedAt: string;
}

/**
 * MCP 工具定义
 */
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description?: string;
      enum?: string[];
    }>;
    required?: string[];
  };
}

/**
 * MCP 使用记录
 */
export interface MCPUsageRecord {
  mcpKey: string;
  toolName: string;
  roleId: string;
  meetingId: string;
  executedAt: string;
  success: boolean;
  duration?: number;
  error?: string;
}

/**
 * MCP 配置
 */
export interface CompanyMCPPoolConfig {
  contextSharer: ContextSharer;
}

// ==================== CompanyMCPPool 类 ====================

export class CompanyMCPPool {
  private contextSharer: ContextSharer;

  constructor(config: CompanyMCPPoolConfig) {
    this.contextSharer = config.contextSharer;
  }

  // ==================== CRUD 操作 ====================

  /**
   * 添加私有 MCP
   */
  async addPrivateMCP(companyId: string, mcp: Omit<CompanyMCP, 'companyId' | 'id' | 'source' | 'usageCount' | 'createdAt' | 'updatedAt' | 'status'>): Promise<CompanyMCP> {
    const now = new Date().toISOString();
    
    const newMCP: CompanyMCP = {
      ...mcp,
      id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      companyId,
      source: 'private',
      status: 'active',
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    // 验证配置
    this.validateMCPConfig(newMCP);

    // 加密敏感信息
    if (newMCP.env) {
      newMCP.env = this.encryptEnvVars(newMCP.env);
    }

    const mcps = await this.getCompanyMCPs(companyId);
    mcps.push(newMCP);
    await this.saveCompanyMCPs(companyId, mcps);

    return newMCP;
  }

  /**
   * 启用系统级 MCP
   */
  async enableSystemMCP(companyId: string, systemMCPKey: string, config?: {
    allowedRoles?: string[];
    env?: Record<string, string>;
  }): Promise<CompanyMCP> {
    const systemMCP = await this.getSystemMCP(systemMCPKey);
    
    if (!systemMCP) {
      throw new Error(`系统 MCP 不存在: ${systemMCPKey}`);
    }

    if (!systemMCP.isPublic) {
      throw new Error(`系统 MCP 不对公司开放: ${systemMCPKey}`);
    }

    const now = new Date().toISOString();
    
    const newMCP: CompanyMCP = {
      id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      companyId,
      name: systemMCP.name,
      key: systemMCP.key,
      description: systemMCP.description,
      source: 'system',
      systemMCPId: systemMCP.id,
      transport: systemMCP.transport,
      command: systemMCP.command,
      args: systemMCP.args,
      url: systemMCP.url,
      headers: systemMCP.headers,
      env: config?.env ? this.encryptEnvVars(config.env) : undefined,
      enabled: true,
      allowedRoles: config?.allowedRoles,
      status: 'active',
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const mcps = await this.getCompanyMCPs(companyId);
    
    // 检查是否已启用
    const existing = mcps.find(m => m.key === systemMCPKey);
    if (existing) {
      existing.enabled = true;
      existing.allowedRoles = config?.allowedRoles;
      existing.updatedAt = now;
      if (config?.env) {
        existing.env = this.encryptEnvVars(config.env);
      }
    } else {
      mcps.push(newMCP);
    }

    await this.saveCompanyMCPs(companyId, mcps);
    return existing ?? newMCP;
  }

  /**
   * 获取公司 MCP
   */
  async getMCP(companyId: string, mcpKey: string): Promise<CompanyMCP | null> {
    const mcps = await this.getCompanyMCPs(companyId);
    return mcps.find(m => m.key === mcpKey) ?? null;
  }

  /**
   * 更新公司 MCP
   */
  async updateMCP(companyId: string, mcpKey: string, updates: Partial<CompanyMCP>): Promise<CompanyMCP | null> {
    const mcps = await this.getCompanyMCPs(companyId);
    const index = mcps.findIndex(m => m.key === mcpKey);
    
    if (index === -1) {
      return null;
    }

    const updated: CompanyMCP = {
      ...mcps[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    // 不能修改的字段
    updated.id = mcps[index].id;
    updated.companyId = mcps[index].companyId;
    updated.source = mcps[index].source;
    updated.systemMCPId = mcps[index].systemMCPId;
    updated.createdAt = mcps[index].createdAt;

    // 加密敏感信息
    if (updates.env) {
      updated.env = this.encryptEnvVars(updates.env);
    }

    mcps[index] = updated;
    await this.saveCompanyMCPs(companyId, mcps);

    return updated;
  }

  /**
   * 禁用 MCP
   */
  async disableMCP(companyId: string, mcpKey: string): Promise<boolean> {
    return this.updateMCP(companyId, mcpKey, { enabled: false }).then(m => m !== null);
  }

  /**
   * 删除私有 MCP
   */
  async deletePrivateMCP(companyId: string, mcpKey: string): Promise<boolean> {
    const mcps = await this.getCompanyMCPs(companyId);
    const index = mcps.findIndex(m => m.key === mcpKey && m.source === 'private');
    
    if (index === -1) {
      return false;
    }

    mcps.splice(index, 1);
    await this.saveCompanyMCPs(companyId, mcps);
    return true;
  }

  /**
   * 列出公司 MCP
   */
  async listMCPs(companyId: string, filter?: {
    source?: MCPSource;
    enabled?: boolean;
    status?: MCPStatus;
  }): Promise<CompanyMCP[]> {
    let mcps = await this.getCompanyMCPs(companyId);

    if (filter) {
      if (filter.source) {
        mcps = mcps.filter(m => m.source === filter.source);
      }
      if (filter.enabled !== undefined) {
        mcps = mcps.filter(m => m.enabled === filter.enabled);
      }
      if (filter.status) {
        mcps = mcps.filter(m => m.status === filter.status);
      }
    }

    return mcps;
  }

  // ==================== 角色权限控制 ====================

  /**
   * 检查角色是否有权限使用 MCP
   */
  async hasPermission(companyId: string, roleId: string, mcpKey: string): Promise<boolean> {
    const mcp = await this.getMCP(companyId, mcpKey);
    
    if (!mcp || !mcp.enabled) {
      return false;
    }

    // 未设置 allowedRoles = 所有角色都可访问
    if (!mcp.allowedRoles || mcp.allowedRoles.length === 0) {
      return true;
    }

    return mcp.allowedRoles.includes(roleId);
  }

  /**
   * 设置 MCP 角色权限
   */
  async setRolePermissions(companyId: string, mcpKey: string, allowedRoles: string[]): Promise<CompanyMCP | null> {
    return this.updateMCP(companyId, mcpKey, { allowedRoles });
  }

  /**
   * 获取角色可用的 MCP 列表
   */
  async getRoleMCPs(companyId: string, roleId: string): Promise<CompanyMCP[]> {
    const mcps = await this.getCompanyMCPs(companyId);
    
    return mcps.filter(m => {
      if (!m.enabled) {
        return false;
      }
      
      // 未设置 allowedRoles = 所有角色
      if (!m.allowedRoles || m.allowedRoles.length === 0) {
        return true;
      }
      
      return m.allowedRoles.includes(roleId);
    });
  }

  // ==================== MCP 工具管理 ====================

  /**
   * 获取 MCP 工具列表
   */
  async getMCPTools(companyId: string, mcpKey: string): Promise<MCPTool[]> {
    const mcp = await this.getMCP(companyId, mcpKey);
    
    if (!mcp || !mcp.enabled) {
      return [];
    }

    // 这里应该调用实际的 MCP 客户端获取工具列表
    // 简化实现：从缓存读取
    const tools = await this.contextSharer.getValue<MCPTool[]>(`company:${companyId}:mcp:${mcpKey}:tools`);
    return tools ?? [];
  }

  /**
   * 缓存 MCP 工具列表
   */
  async cacheMCPTools(companyId: string, mcpKey: string, tools: MCPTool[]): Promise<void> {
    await this.contextSharer.set(`company:${companyId}:mcp:${mcpKey}:tools`, tools);
  }

  // ==================== 使用统计 ====================

  /**
   * 记录 MCP 使用
   */
  async recordUsage(
    companyId: string,
    mcpKey: string,
    toolName: string,
    roleId: string,
    meetingId: string,
    result: { success: boolean; duration?: number; error?: string }
  ): Promise<void> {
    // 更新 MCP 统计
    const mcps = await this.getCompanyMCPs(companyId);
    const mcp = mcps.find(m => m.key === mcpKey);
    
    if (mcp) {
      mcp.usageCount++;
      mcp.lastUsedAt = new Date().toISOString();
      if (!result.success) {
        mcp.status = 'error';
        mcp.lastError = result.error;
      }
      await this.saveCompanyMCPs(companyId, mcps);
    }

    // 记录使用日志
    const record: MCPUsageRecord = {
      mcpKey,
      toolName,
      roleId,
      meetingId,
      executedAt: new Date().toISOString(),
      success: result.success,
      duration: result.duration,
      error: result.error,
    };

    await this.appendUsageRecord(companyId, record);
  }

  /**
   * 获取 MCP 使用统计
   */
  async getUsageStats(companyId: string, mcpKey?: string): Promise<{
    totalUsage: number;
    successRate: number;
    avgDuration: number;
    byTool: Record<string, number>;
  }> {
    const records = await this.getUsageRecords(companyId);
    const filtered = mcpKey ? records.filter(r => r.mcpKey === mcpKey) : records;
    
    const successCount = filtered.filter(r => r.success).length;
    const durations = filtered.filter(r => r.duration).map(r => r.duration!);
    
    // 按工具统计
    const byTool: Record<string, number> = {};
    for (const record of filtered) {
      byTool[record.toolName] = (byTool[record.toolName] ?? 0) + 1;
    }

    return {
      totalUsage: filtered.length,
      successRate: filtered.length > 0 ? successCount / filtered.length : 0,
      avgDuration: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
      byTool,
    };
  }

  // ==================== 系统级 MCP 管理 ====================

  /**
   * 列出可用的系统级 MCP
   */
  async listSystemMCPs(): Promise<SystemMCP[]> {
    const data = await this.contextSharer.getValue<SystemMCP[]>('system:mcp-templates');
    return data ?? [];
  }

  /**
   * 获取系统级 MCP
   */
  private async getSystemMCP(key: string): Promise<SystemMCP | null> {
    const mcps = await this.listSystemMCPs();
    return mcps.find(m => m.key === key) ?? null;
  }

  // ==================== 私有方法 ====================

  private async getCompanyMCPs(companyId: string): Promise<CompanyMCP[]> {
    const data = await this.contextSharer.getValue<CompanyMCP[]>(`company:${companyId}:mcps`);
    return data ?? [];
  }

  private async saveCompanyMCPs(companyId: string, mcps: CompanyMCP[]): Promise<void> {
    await this.contextSharer.set(`company:${companyId}:mcps`, mcps);
  }

  private async getUsageRecords(companyId: string): Promise<MCPUsageRecord[]> {
    const data = await this.contextSharer.getValue<MCPUsageRecord[]>(`company:${companyId}:mcp-usage`);
    return data ?? [];
  }

  private async appendUsageRecord(companyId: string, record: MCPUsageRecord): Promise<void> {
    const records = await this.getUsageRecords(companyId);
    records.push(record);
    
    // 只保留最近 1000 条
    const trimmed = records.slice(-1000);
    await this.contextSharer.set(`company:${companyId}:mcp-usage`, trimmed);
  }

  /**
   * 验证 MCP 配置
   */
  private validateMCPConfig(mcp: CompanyMCP): void {
    if (!mcp.transport) {
      throw new Error('MCP transport 是必填项');
    }

    if (mcp.transport === 'stdio' && !mcp.command) {
      throw new Error('stdio MCP 需要指定 command');
    }

    if ((mcp.transport === 'http' || mcp.transport === 'websocket') && !mcp.url) {
      throw new Error(`${mcp.transport} MCP 需要指定 url`);
    }
  }

  /**
   * 加密环境变量（简化实现）
   */
  private encryptEnvVars(env: Record<string, string>): Record<string, string> {
    // 实际实现应该使用加密库
    // 这里使用 base64 作为占位符
    const encrypted: Record<string, string> = {};
    
    for (const [key, value] of Object.entries(env)) {
      // 检测敏感 key
      const isSensitive = /password|secret|token|key|credential/i.test(key);
      
      if (isSensitive) {
        encrypted[key] = `enc:${Buffer.from(value).toString('base64')}`;
      } else {
        encrypted[key] = value;
      }
    }
    
    return encrypted;
  }

  /**
   * 解密环境变量
   */
  decryptEnvVars(env: Record<string, string>): Record<string, string> {
    const decrypted: Record<string, string> = {};
    
    for (const [key, value] of Object.entries(env)) {
      if (value.startsWith('enc:')) {
        decrypted[key] = Buffer.from(value.slice(4), 'base64').toString('utf-8');
      } else {
        decrypted[key] = value;
      }
    }
    
    return decrypted;
  }
}

// ==================== 工厂函数 ====================

export function createCompanyMCPPool(config: CompanyMCPPoolConfig): CompanyMCPPool {
  return new CompanyMCPPool(config);
}
