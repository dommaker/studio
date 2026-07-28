# src

> 此文件描述 packages/studio-shared/src 目录的职责和上下文。
> 请阅读本目录的源代码，然后填写以下各节。
> 如果使用 AI 编码助手，将本文件内容作为 prompt 请求它分析并填写。

<!-- STALE_SINCE: 2026-07-28 -->
⚠️ 以下文件已变更，本节可能过期: packages/studio-shared/src/file-store.ts, packages/studio-shared/src/index.ts, packages/studio-shared/src/CONTEXT.md, packages/studio-shared/src/node.ts, packages/studio-shared/src/providers.ts

## 职责

本目录是 Agent-Studio 的前后端共享库，提供 CLI 框架、配置管理、常量定义、事件总线与文件存储等通用基础设施，为 apps/api 等多个上层模块提供复用的工具与类型。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `Parser`, `ParsedArgs` | cli/parser | 命令行参数解析，支持短参数、长参数、JSON 等 |
| `formatOutput`, `Format` | cli/formatter | 输出格式化 (table/json/csv) |
| `loadConfig`, `getConfig`, `StudioConfig` | cli/config | CLI 配置文件 (.studio/config.yaml) 加载与访问 |
| `registerCommand`, `getCommand`, `runCommand`, `Command` | cli/command | 命令注册与执行框架 |
| `formatError`, `createCliError`, `CliError`, `ERROR_CODES` | cli/error | 统一错误处理与格式化为字符串 |
| `loadConfigEnv`, `AgentStudioConfig` | config | 系统级配置加载 (~/.studio/config.env) 及类型定义 |
| `getModelForTier`, `ModelTier` | config/model-tier | 模型等级到实际模型的映射 |
| `LEVEL_CONFIG`, `getLevelConfig`, `getLevelSalary` 等 | constants/levels | 全局统一的职级配置与辅助函数 |
| `RESPONSIBILITY_CHAIN`, `CHANGE_TYPE_EXPERTS`, `Stage`, `Role` 等 | constants/responsibility-chain | 责任链模型类型与常量定义 |
| `STAGE_DEFINITIONS`, `StageDefinition` | constants/stage-definitions | 开发阶段详细定义、关键词与推荐函数 |
| `eventBus`, `StudioEventBus` | event-bus | 内存事件总线，支持通配符订阅 |
| `AgentProfileData`, `RuntimeStateData`, `ChannelData`, `ChannelMessageData` 等 | file-store | 文件存储基础数据类型 |

## 依赖关系

**上游（本目录依赖）**
- Node.js 内置模块: `fs`, `path`, `os`, `events`, `crypto`
- 第三方库: `yaml`

**下游（依赖本目录的模块）**
- `apps/api` 全套模块（daemon、middleware、modules、index、cli 等）广泛引用本目录的 CLI 框架、配置管理、事件总线及 file-store 类型

## 注意事项

- CLI 命令注册表为全局单例，测试后需调用 `clearCommands()` 清理
- 配置优先级：环境变量 > `~/.studio/config.env` > 默认值，且仅当环境变量未设置时才加载 config.env
- `FileStore` 使用 `flock` 目录锁（`mkdir` 原子操作）保障 claim 原子性
- 事件总线支持通配符（`*`）模式订阅，Handler 异常不会影响其他监听器
- 级别与责任链常量为单一数据源，其他模块不应重复定义
- `constants/` 下各文件应保持无外部依赖（仅内部引用），便于前端复用

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `240f7885`: passwordHash 泄露 + workspace 端点 Admin 加硬 + 本地 CLI 扫描修复
- ✅ `ddccf47a`: studio-shared): FileStore 原子写与 index 并发写加锁
- ✅ `6d6ada83`: spec4-p2): Phase 2 收尾 — FileStore mock 更新 + writeJsonl 方法
- ✅ `5408f1dc`: web): 修复 ProjectDetailPage 加载任务失败阻塞页面 + 修复 monitoring/stats 500
- ✅ `5b7ec85c`: web): 修复 4 个生产崩溃 + 菜单冗余整合
