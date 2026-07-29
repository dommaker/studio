/**
 * CLI Spawn 环境变量构造（已简化）
 *
 * @deprecated AC-1.11: buildSpawnEnv 已简化为仅透传 extra。
 * 新代码请使用 `systemExecutor`（apps/api/src/modules/agents/system-executor.ts）
 * 或直接 `execSh` + `buildArgsFromTemplate`。CLI 自己读鉴权配置（~/.claude/settings.json），
 * studio 不再注入全局 key/MODEL/DATABASE_URL。
 *
 * 本文件保留至 AC Group 7（Phase 4）统一删除，过渡期消费方（studio-agent 包
 * runner-params.ts / session-manager.ts、review-agent.service.ts）未迁移完前不破坏编译。
 *
 * 历史行为（已移除）：
 *   - 按 role 选 STUDIO_API_KEY 或 PIPELINE_API_KEY（agent network 时代 CLI 自管鉴权）
 *   - 按 tier 选 ANTHROPIC_MODEL（CLI 自管 model）
 *   - DATABASE_URL 空字符串隔离（DB 已删）
 *   - /v1 到 /anthropic URL 改写（systemExecutor 自己处理）
 */
/**
 * @deprecated use systemExecutor or execSh + buildArgsFromTemplate
 */
export function buildSpawnEnv(options = {}) {
    const { extra } = options;
    return { ...extra };
}
//# sourceMappingURL=spawn-claude-cli.js.map