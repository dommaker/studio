# apps/api/src/modules/agent-knowledge

### 职责

知识维护 Agent（P2-d 刀7 自 modules/agents/knowledge 提升为顶层模块）：知识库冷启动导入 + 每日维护。命名 agent-knowledge 以区别于顶层 `knowledge` 模块（知识引擎：Producer → Engine → Consumer 三层架构）——本模块是知识引擎的「维护 Agent」消费方/调用方，不是引擎本体。

### 目录结构

- `knowledge-curator.service.ts` — 门面（冷启动 + 每日维护调度；`knowledgeCurator` 单例 + `getExtractFromTextSystemPrompt` 提取 prompt 单一来源）
- `knowledge-cold-start.ts` — 四源导入（docs/code/git/manual）
- `knowledge-extraction.ts` — 提取 prompt 单一来源
- `knowledge-maintenance.ts` — 语义去重/质量评估/过期验证/矛盾审查
- `__tests__/` — knowledge-cold-start / knowledge-extraction / knowledge-maintenance

### 核心导出

- `index.ts` — 模块公共出口 barrel：`knowledgeCurator`、`getExtractFromTextSystemPrompt`

### 依赖关系

- 上游：`modules/agents`（barrel：getSystemExecutor，轻量 LLM 直调）、`modules/knowledge`（引擎本体）、`core/store`、`utils/discord-notifier`
- 下游：`bootstrap/warmup.ts`（冷启动导入）、`modules/knowledge`（maintenance.routes 每日维护触发 / knowledge-service 复用提取 prompt，均动态 import）、`modules/agent-monitor`（monitor-system-probes 知识健康检查，动态 import）

### 注意事项

- **SystemExecutor 按源超时（#369）**：重 prompt 源 knowledge-distill / knowledge-maintenance 注册 120s（依据 #365 实测蒸馏 21-27s 撞 30s 上限）；新调用点必须带 eventSource（同时是 system:tokens 成本聚合键）
- **P8 知识提取总开关**：`STUDIO_KNOWLEDGE_EXTRACTION=false` 时 knowledge-service extractFromConversation 直接跳过（无凭证/fake-provider 环境豁免）
- knowledge→agent-knowledge 反向边维持动态 import（P2-c 拆环口径，静态值边保持清零）
