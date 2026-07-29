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
/**
 * 加载 ~/.studio/config.env 到 process.env（仅当 env 未设置时）
 */
export declare function loadConfigEnv(): void;
export interface AgentStudioConfig {
    worktreesDir: string;
    repoDir: string;
    outputsDir: string;
    dockerImage: string;
    taskTimeoutMinutes: number;
    heartbeatIntervalMinutes: number;
    defaultAgentType: 'codex' | 'claude';
    codingApiKey1?: string;
    codingApiKey2?: string;
    anthropicApiKey1?: string;
    anthropicApiKey2?: string;
    anthropicBaseUrl?: string;
}
/**
 * 加载 Agent Studio 配置
 */
export declare function loadAgentStudioConfig(): AgentStudioConfig;
export declare const agentStudioConfig: AgentStudioConfig;
/**
 * 获取 API Key
 */
export declare function getApiKey(keyIndex?: 1 | 2): {
    codingApiKey?: string;
    anthropicApiKey?: string;
};
/**
 * 检查必需的配置
 */
export declare function checkRequiredConfig(): {
    valid: boolean;
    missing: string[];
};
/**
 * 按 provider 获取 API Key（统一入口，禁止直接 process.env）
 */
export type LlmProvider = 'deepseek' | 'anthropic' | 'openai' | 'coding';
//# sourceMappingURL=index.d.ts.map