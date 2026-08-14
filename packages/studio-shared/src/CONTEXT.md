# src

> 此文件描述 packages/studio-shared/src 目录的职责和上下文。
> 请阅读本目录的源代码，然后填写以下各节。
> 如果使用 AI 编码助手，将本文件内容作为 prompt 请求它分析并填写。

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
| `LEVEL_CONFIG`, `getLevelConfig`, `getLevelSalary` 等 | constants/levels | 全局统一的职级配置与辅助函数 |
| `eventBus`, `StudioEventBus` | event-bus | 内存事件总线，支持通配符订阅 |
| `AgentProfileData`, `RuntimeStateData`, `ChannelData`, `ChannelMessageData` 等 | file-store | 文件存储基础数据类型 |
| `EvolutionProposalData`（constraintChange: message/exception/new-entry/retire——retire 为 #82 D6 退役落点） | file-store-types | E1 进化提案类型 |
| `resolveVpsWorkspace`, `resolveWorkspacesDir` | vps-workspace（仅 /node 入口） | 'VPS' 工作区命名约定与 ~/.studio/workspaces 扫描的唯一属主（2026-08 起；worktree-resolver 与 local-workspace 均委托到此，禁止第三处手扫） |
| `studioDir`, `studioPath`, `defaultStudioDir`, `warnIfNonProdUsesProdRoot` | config/studio-dir（`./studio-dir` 子路径入口） | 数据根解析单入口（issue #89）：STUDIO_HOME 优先，缺省 ~/.studio；全部数据区读写必须经此，禁止新增 `os.homedir() + '.studio'` 硬编码 |

## 依赖关系

**上游（本目录依赖）**
- Node.js 内置模块: `fs`, `path`, `os`, `events`, `crypto`
- 第三方库: `yaml`

**下游（依赖本目录的模块）**
- `apps/api` 全套模块（daemon、middleware、modules、index、cli 等）广泛引用本目录的 CLI 框架、配置管理、事件总线及 file-store 类型

## 注意事项

- CLI 命令注册表为全局单例，测试后需调用 `clearCommands()` 清理
- 配置优先级：环境变量 > `~/.studio/config.env` > 默认值，且仅当环境变量未设置时才加载 config.env
- 数据根：`studioDir()`（config/studio-dir）= `STUDIO_HOME` 或 `~/.studio`；config.env 与 `STUDIO_DATA_DIR ??=` 钉值均走它。dev 启动（scripts/dev/start.sh、apps/api dev script）默认 `STUDIO_HOME=~/.studio-dev`，prod systemd 显式 `/root/.studio`；非 production 指向缺省根时 `warnIfNonProdUsesProdRoot()` 落 warning（config/index.ts 初始化 + apps/api 入口显式调用，幂等）
- `studioDir()` 内含 vitest 内建模块双视图兼容层（resolveHomedir）：仓库测试对 `os.homedir` 有四种互不兼容的 mock 风格，该层保证迁移后的 SUT 在旧 mock 下仍被隔离；生产两视图恒等。测试收敛到 env 隔离后可删除（见 code-review follow-up）
- `FileStore` 使用 `flock` 目录锁（`mkdir` 原子操作）保障 claim 原子性
- `FileStore` 的 readJson/readJsonl/readdir 走模块级读穿缓存（stat mtime 校验 + 写/删精确失效，工单 26 A1）；缓存命中返回结构克隆，调用方 mutate 返回值不会污染缓存；`readIndexFile` 保持无缓存（锁内跨进程正确性）
- `FileStore` 的 Requirement/Evolution 段共用泛型「序号分配型条目存储」实现（`SeqEntryStoreConfig`，工单 26 A2），新增同类存储应加配置而非复制段
- 事件总线支持通配符（`*`）模式订阅，Handler 异常不会影响其他监听器
- 级别常量为单一数据源，其他模块不应重复定义
- `constants/` 下各文件应保持无外部依赖（仅内部引用），便于前端复用
