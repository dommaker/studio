/**
 * Config - TypeScript 配置管理
 * ============================================================================
 * 功能: 替代 config.sh，提供统一的配置管理
 * 
 * 配置优先级:
 *   1. 环境变量
 *   2. .env 文件
 *   3. 默认值
 */

import * as path from 'path';
import * as os from 'os';

export interface AgentStudioConfig {
  // 路径配置
  worktreesDir: string;
  repoDir: string;
  outputsDir: string;
  
  // Docker 配置
  dockerImage: string;
  
  // 超时配置
  taskTimeoutMinutes: number;
  heartbeatIntervalMinutes: number;
  
  // Agent 配置
  defaultAgentType: 'codex' | 'claude';
  
  // Redis 配置
  redisUrl: string;
  
  // API Keys（从环境变量读取）
  codingApiKey1?: string;
  codingApiKey2?: string;
  anthropicApiKey1?: string;
  anthropicApiKey2?: string;
  anthropicBaseUrl?: string;
  anthropicModel?: string;
}

// 默认配置
const DEFAULT_CONFIG: AgentStudioConfig = {
  worktreesDir: path.join(os.homedir(), 'worktrees'),
  repoDir: path.join(os.homedir(), 'projects', 'agent-skills'),
  outputsDir: path.join(os.homedir(), 'outputs'),
  dockerImage: 'claude-code:fast',
  taskTimeoutMinutes: 60,
  heartbeatIntervalMinutes: 10,
  defaultAgentType: 'codex',
  redisUrl: 'redis://localhost:6379',
};

/**
 * 加载 Agent Studio 配置
 */
export function loadAgentStudioConfig(): AgentStudioConfig {
  return {
    // 路径配置
    worktreesDir: process.env.WORKTREES_DIR || DEFAULT_CONFIG.worktreesDir,
    repoDir: process.env.REPO_DIR || DEFAULT_CONFIG.repoDir,
    outputsDir: process.env.OUTPUTS_DIR || DEFAULT_CONFIG.outputsDir,
    
    // Docker 配置
    dockerImage: process.env.DOCKER_IMAGE || DEFAULT_CONFIG.dockerImage,
    
    // 超时配置
    taskTimeoutMinutes: parseInt(process.env.TASK_TIMEOUT_MINUTES || '', 10) || DEFAULT_CONFIG.taskTimeoutMinutes,
    heartbeatIntervalMinutes: parseInt(process.env.HEARTBEAT_INTERVAL_MINUTES || '', 10) || DEFAULT_CONFIG.heartbeatIntervalMinutes,
    
    // Agent 配置
    defaultAgentType: (process.env.DEFAULT_AGENT_TYPE as 'codex' | 'claude') || DEFAULT_CONFIG.defaultAgentType,
    
    // Redis 配置
    redisUrl: process.env.REDIS_URL || DEFAULT_CONFIG.redisUrl,
    
    // API Keys
    codingApiKey1: process.env.CODING_API_KEY_1,
    codingApiKey2: process.env.CODING_API_KEY_2,
    anthropicApiKey1: process.env.ANTHROPIC_API_KEY_1 || process.env.ANTHROPIC_API_KEY,
    anthropicApiKey2: process.env.ANTHROPIC_API_KEY_2,
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
    anthropicModel: process.env.ANTHROPIC_MODEL,
  };
}

// 全局配置实例
export const agentStudioConfig = loadAgentStudioConfig();

/**
 * 获取 API Key
 */
export function getApiKey(keyIndex: 1 | 2 = 1): {
  codingApiKey?: string;
  anthropicApiKey?: string;
} {
  return {
    codingApiKey: keyIndex === 1 ? agentStudioConfig.codingApiKey1 : agentStudioConfig.codingApiKey2,
    anthropicApiKey: keyIndex === 1 ? agentStudioConfig.anthropicApiKey1 : agentStudioConfig.anthropicApiKey2,
  };
}

/**
 * 检查必需的配置
 */
export function checkRequiredConfig(): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  
  // 至少需要一个 API Key
  if (!agentStudioConfig.codingApiKey1 && !agentStudioConfig.anthropicApiKey1) {
    missing.push('CODING_API_KEY_1 or ANTHROPIC_API_KEY');
  }
  
  return {
    valid: missing.length === 0,
    missing,
  };
}