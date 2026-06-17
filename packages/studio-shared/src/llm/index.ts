// LLM 模块导出

export { LLMClient, llmClient } from './llm-client.js';
export type { LLMConfig, ChatMessage, ChatCompletionRequest, ChatCompletionResponse } from './llm-client.js';

export { ModelGateway, modelGateway } from './model-gateway.js';
export type { ProviderConfig, GatewayMessage, GatewayRequest, GatewayResponse, UsageRecord, GatewayStats } from './model-gateway.js';

export { buildSpawnEnv } from './spawn-claude-cli.js';
export type { SpawnEnvOptions } from './spawn-claude-cli.js';

export { parseStreamEvents, parseStreamLine, extractToolCalls, extractFilePath, extractResult, extractUsage, extractWriteContent } from './stream-json-parser.js';
export type { StreamEvent, ToolCall } from './stream-json-parser.js';