/**
 * Config - TypeScript 配置管理
 * ============================================================================
 * 功能: 替代 config.sh，提供统一的配置管理
 *
 * 配置优先级:
 *   1. 环境变量（最高，.env 覆盖）
 *   2. ~/.studio/config.env（统一配置文件）
 *   3. 默认值
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/**
 * 加载 ~/.studio/config.env 到 process.env（仅当 env 未设置时）
 */
export function loadConfigEnv(): void {
  const configPath = path.join(os.homedir(), '.studio', 'config.env');
  if (!fs.existsSync(configPath)) return;

  const content = fs.readFileSync(configPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    // 仅当环境变量未设置时才加载（env 优先级更高）
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// 启动时自动加载 config.env
loadConfigEnv();

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

/**
 * 按 provider 获取 API Key（统一入口，禁止直接 process.env）
 */
export type LlmProvider = 'deepseek' | 'anthropic' | 'openai' | 'coding';

/** Workload 类型：conversation（对话）/ pipeline（管线）/ undefined（默认） */
export type WorkloadType = 'conversation' | 'pipeline';

const PROVIDER_KEY_MAP: Record<LlmProvider, string[]> = {
  deepseek: ['DEEPSEEK_API_KEY'],
  anthropic: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY_1', 'ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY', 'LLM_API_KEY'],
  coding: ['CODING_API_KEY_1'],
};

/**
 * 按 provider + workload 获取 API Key
 *
 * workload 优先级:
 *   'conversation' → CONVERSATION_API_KEY → fallback to base keys
 *   'pipeline'     → PIPELINE_API_KEY → fallback to base keys
 *   undefined      → base keys only (current behavior)
 */
export function getProviderApiKey(provider: LlmProvider, workload?: WorkloadType): string | undefined {
  // Workload-specific key takes priority
  if (workload === 'conversation') {
    const convKey = process.env.CONVERSATION_API_KEY;
    if (convKey) return convKey;
  } else if (workload === 'pipeline') {
    const pipeKey = process.env.PIPELINE_API_KEY;
    if (pipeKey) return pipeKey;
  }

  // Fallback to provider's base key chain
  const keys = PROVIDER_KEY_MAP[provider];
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
}

/**
 * 获取所有已配置的 provider 列表
 */
export function getConfiguredProviders(): LlmProvider[] {
  const providers: LlmProvider[] = [];
  for (const provider of Object.keys(PROVIDER_KEY_MAP) as LlmProvider[]) {
    if (getProviderApiKey(provider)) {
      providers.push(provider);
    }
  }
  return providers;
}

/**
 * 获取配置摘要（masked）
 */
export function getConfigSummary(): Record<string, string> {
  const summary: Record<string, string> = {};
  const allKeys = [
    'DEEPSEEK_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY', 'LLM_API_KEY', 'CODING_API_KEY_1',
    'CONVERSATION_API_KEY', 'PIPELINE_API_KEY',
    'JWT_SECRET', 'ENCRYPTION_KEY',
    'DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY',
  ];
  for (const key of allKeys) {
    const value = process.env[key];
    if (value) {
      summary[key] = value.length > 8
        ? `${value.slice(0, 4)}...${value.slice(-4)}`
        : '****';
    }
  }
  return summary;
}