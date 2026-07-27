# studio-shared

> 此文件描述 packages/studio-shared 目录的职责和上下文

## 职责

跨 apps/packages 的共享层：provider 注册表（agent CLI 定义与 spawn 模板）、FileStore（全部运行时数据的文件存储）、eventBus、共享类型与工具、 harness 运行时。Node-only 能力经 `@dommaker/studio-shared/node` 子路径导出（读 fs，前端不可引）。

## 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `BUILTIN_PROVIDERS` / `ProviderDefinition` | `src/providers.ts` | 内置 4 个 agent CLI 定义（claude/kimi/codex/opencode；openclaw 为 config-only legacy）：binaries、versionArgs、healthProbeArgs、spawn 模板 |
| `listScanProviders()` / `resolveProviderDefinition()` / `buildArgsFromTemplate()` / `buildHealthProbeCommand()` | `src/providers.ts` | 扫描清单、定义解析（含 GENERIC 兜底）、CLI argv 构建、健康探针命令 |
| `loadProviderRegistry()` / `resetProviderRegistryCache()` | `src/providers.ts` | 内置 + 用户覆盖（`~/.studio/providers.json`）深合并，带缓存；**新增 CLI 扩展点 = 写 providers.json，不改代码** |
| `FileStore` | `src/file-store.ts` | 全部运行时数据的文件存储（原子写 tmp+rename + mkdir 锁 withLock），baseDir 默认 `~/.studio/data` |
| `AgentProfileData` / `RuntimeStateData` | `src/file-store.ts` | Agent 身份模型（`{id,name,description,channels(废弃),status,provider,nodeId}`，**无 systemPrompt 字段**）与运行时实例模型 |
| `eventBus` | `src/event-bus*` | 进程内事件总线（agent-profile.created 等触发 AgentLoopRegistry mount） |

## 依赖关系

上游：`@dommaker/harness`、`eventemitter3`、`yaml`。
下游：apps/api 各模块、packages/studio-agent、apps/web（仅类型，不可引 `/node` 子路径）。

## 注意事项

- **FileStore 目录布局**（`~/.studio/data/`）：`agents/{id}/profile.json` + `agents/{id}/state.json`（Agent 身份与运行时实例，永久存在仅可显式 DELETE）；channels/workunits 等同理按域分目录。其他相关路径：`~/.studio/providers.json`（provider 覆盖）、`~/.studio/workspaces/{id}.json`（workspace 记录，内嵌 runtimes）。
- provider 注册表是"装了哪些 CLI"的唯一权威定义：daemon 扫描（`apps/api/src/daemon/cli-scanner.ts`）、本地扫描（`local-workspace.ts`）、spawn（`cli-adapter.ts`）、健康探针（`agent-loop.ts`）全部从这里取定义，新增 CLI 只需 `~/.studio/providers.json`。
- FileStore 写操作全部原子写（tmp+rename），跨进程并发经 `withLock()`（mkdir 锁）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ 2026-07-27: B5 D18 — events-dir.ts 注释更新：apps/api 内事件读写已全部收敛到 ~/.studio/logs/studio-events.jsonl（apps/api/src/utils/studio-events.ts 单一入口），resolveEventsDir 仅剩仓外遗留消费方（如 events-daemon 目录约定），仓内无生产调用方
- ✅ 2026-07 频道角色排查沉淀：新建本文件 —— provider 注册表与 FileStore 布局是频道角色修复探明的跨模块核心知识
