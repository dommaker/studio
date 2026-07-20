# llm

> 此文件描述 apps/api/src/modules/llm 目录的职责和上下文

## 职责

提供 LLM（大语言模型）配置管理、统一代理接口和意图分析功能。包括多 scope（orchestrator、agent 等）配置的 CRUD 与解析（从 UI 配置与环境变量动态合并）、对下游 Chat 请求的代理转发（/api/v1/llm/chat），以及基于 LLM 的意图分析（IntentAnalyzer）和 Skill 创建配置生成（CreationAnalyzer）。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `configRoutes` (默认导出 Router) | config.routes.ts | LLM 配置 API 路由（GET/POST/DELETE /api/v1/llm/config） |
| `proxyRoutes` (默认导出 Router) | proxy.ts | LLM 代理路由（/api/v1/llm/status, /chat, /models） |
| `llmConfigService` | config.service.ts | 配置服务实例（含加载、保存、测试、脱敏） |
| `ResolvedLLMConfig` / `LLMConfigInput` 等类型 | config.service.ts | LLM 配置相关类型定义 |
| `CreationIntent`, `SkillConfig` 等类型与函数 | creation-analyzer.ts | 创建意图分析与 Skill 配置生成 |
| `IntentResult` 等类型与函数 | intent-analyzer.ts | 意图分析（匹配能力） |

## 依赖关系

上游依赖：
- `@dommaker/studio-shared`：logger、modelGateway、getProviderApiKey、FileStore 等工具
- `../capabilities/routes`（intent-analyzer.ts 引入 `loadRegistry`）

下游依赖：
- `apps/api/src/index.ts`：挂载 LLM 配置路由和代理路由
- `apps/api/src/route-registry.ts`：注册路由到统一路由表

## 注意事项

- **配置优先级**：用户配置（process.env.LLM_API_KEY_USER）> 环境变量配置（STUDIO_API_KEY / LLM_API_KEY）> 默认值
- **API Key 脱敏**：GET /api/v1/llm/config 返回的 key 仅显示后 4 位（MaskedLLMConfig）
- **统一代理端点**：intent-analyzer 和 creation-analyzer 均通过 /api/v1/llm/chat 调用 LLM，端口默认取自 PORT 或 3001
- **作用域约束**：config.routes.ts 中 POST /api/v1/llm/config 要求有效 scope（orchestrator/agent_xxx/studio），且必须提供 scope、provider、model
- **文件存储**：配置保存到 ~/.studio/llm-configs.json，而非数据库
- **用户配置仅存进程内存**：通过 Settings 页面保存的 API Key 仅存于 process.env，重启后需重新保存（proxy.ts 注释）
- **LLM 代理状态**：proxy.ts 的 /status 返回 available、model、provider、configured、isUserConfig 字段

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `bf4ad33d`: LLM architecture debt — 3-key routing + P0-P2 fixes
- ✅ `f80cfeae`: 203 TypeScript 错误全部清零
