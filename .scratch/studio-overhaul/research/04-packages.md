# 04 · packages/ 调研报告（全量重构前期）

调研范围：`/root/projects/studio/packages/` 下 9 个子包。全程只读；所有结论均以仓库内 grep 交叉验证（搜索域：apps/、packages/、scripts/、bin/，排除 node_modules、dist、__tests__/ 与 *.test.ts，测试用途单独标注）。

行数统计口径：非测试 `.ts` 文件（排除 `__tests__/` 与 `*.test.ts`）。

---

## 1. 各包档案

### studio-shared — 共享基础设施（工具、类型、FileStore、harness 桥接）
- 规模：55 个源文件 / 7252 行（另有 24 个测试文件，含 file-store.test.ts 1182 行）。
- 导出面（`src/index.ts`，另有 4 个入口）：
  - 主入口 `src/index.ts`（web 安全，无 fs/path）：utils、llm、harness、constants（levels/responsibility-chain/stage-definitions）、domain-vocab、attestation、types、eventBus、memoryStore、FileStore 全家、stats/anomaly-detector。
  - `/node`（`src/node.ts`）：vps-workspace、cli、config、providers + 主入口大部分内容。
  - `/web`（`src/web.ts`）：仅 attestation 等纯逻辑。
  - `/harness`、`/harness/hooks`、`/harness/runtime/bootstrap`、`/cli`、`/constants`、`/stats/*` 子路径。
- 消费方式：全仓 407+ 处 import，是绝对枢纽。apps/web 经 `/web` 入口消费（10 处）；apps/api 经主入口与 `/node`（29 处）；`/harness`、`/harness/hooks` 由 studio-agent 与 apps/api 消费；`/harness/runtime/bootstrap` 仅 apps/api/src/index.ts:22。
- 零消费子路径出口：`/cli`、`/constants`、`/stats/*` 在 package.json `exports` 中声明但全仓无人按子路径 import（`grep studio-shared/cli`、`studio-shared/constants`、`studio-shared/stats` 均 0 命中）。

### studio-agent — Agent 执行器（CLI spawn、session loop、worktree 管理）
- 规模：14 个源文件 / 3105 行（20 个测试文件）。
- 导出面（`src/index.ts`）：`AgentRegistry`、`AgentRunner`/`agentRunner`、`AgentCompleter`/`agentCompleter`、类型（AgentMetadata/JSONSchema/AgentConfig/AgentCapabilities/AgentTask/ExecutionResult）、worktree 四函数（ensureWuWorktree/ensureBranchExists/ensurePmoIntegrationWorktree/getDefaultBranch）、`buildSpawnArgs` 及 cli-adapter 类型。
- 消费方式：apps/api 重度消费（agent-loop.ts、executor.ts、session-manager.ts、discord/routes.ts、pmo/delivery.ts、merge-on-review-pass.ts 等 ~45 文件）。实际被消费的导出：`agentRunner`、`AgentRegistry`、`AgentTask`/`ExecutionResult` 类型、worktree 四函数、`buildSpawnArgs`（apps/api/src/daemon/task-executor.ts、cli-adapter.ts）。
- 未被消费的导出：`AgentCompleter`/`agentCompleter`（见 §4）、`AgentMetadata`/`JSONSchema`/`AgentConfig`/`AgentCapabilities`（apps 各自本地重定义同名 interface，如 apps/api/src/types/index.ts:60，未从包导入）。

### studio-audit — 审计日志服务（JSONL 持久化 + 查询/导出）
- 规模：9 个源文件 / 988 行（4 个测试文件）。
- 导出面（`src/index.ts` 全量 `export *`）：types、services（`AuditService`、`AuditActions`、`AuditResources` + 输入/查询/统计类型）、cli（log/export/search）、`audit-chain`（哈希链防篡改）。
- 消费方式：apps/api 三处 —— middleware/audit-logger.ts:9、modules/audit-logs/routes.ts:3、modules/auth/routes.ts:13，均只用 `AuditService` 系列。
- `audit-chain`（446 行，全包最大文件）与 cli 三个模块（mock 实现）零消费（见 §4、§5）。

### studio-capability — 能力注册/同步/市场服务
- 规模：3 个源文件 / 1105 行（仅 1 个测试：12 行的 import 冒烟测试 `src/__tests__/imports.test.ts`）。
- 导出面：`CapabilityService` + `company-mcp-pool` 全量导出。
- 消费方式：仅 apps/api/src/modules/capabilities/routes.ts:6 使用 `CapabilityService`，调用 10 个方法（create/createMany/getById/getByName/list/update/delete/getStats/getCostConfig/syncFromRegistry）。
- `CompanyMCPPool` 全系与市场四方法零消费（见 §3、§4）。

### studio-monitor — Agent 健康监控（超时/僵尸任务巡检）
- 规模：2 个源文件 / 286 行（1 个测试文件）。
- 导出面：`HealthMonitor`、`startHealthMonitor`、`stopHealthMonitor`。
- 消费方式：仅 apps/api/src/index.ts:15 import；但 **`startHealthMonitor` 全仓无任何调用点**（`grep "startHealthMonitor("` 仅命中包内定义与 index 导出），实际只调用了 `stopHealthMonitor()`（index.ts:413，对从未启动的 monitor 做 no-op 停止）。**该包生产环境实质未运行。**

### studio-notification — 通知服务（JSONL 存储）
- 规模：8 个源文件 / 352 行（4 个测试文件）。
- 导出面：`NotificationService`/`notificationService`、types、cli（send/list/mark，mock 实现）。
- 消费方式：apps/api 三处 —— notifications/routes.ts:6、agents/auditor-execution.ts:17（用类）、spec-reviews/spec-review.service.ts:14（用单例）。cli 零消费。

### studio-skill — Skill 定义加载器（磁盘 SKILL.md + 5 分钟缓存）
- 规模：5 个源文件 / 297 行（3 个测试文件）。
- 导出面：`SkillLoader`/`skillLoader`、`matchIntent`、`SkillDefinition` 类型、`LoadOptions`。
- 消费方式：apps/api/src/modules/mcp/skill.tools.ts:29（`skillLoader.getFullPrompt`）；studio-agent/src/services/runner-params.ts:17（`skillLoader.load` + `formatForPrompt`）。
- `matchIntent`（intent-router.ts，22 行 + 72 行测试）除自身测试外零消费；`src/definitions/index.ts` 是 `export {}` 空 stub。

### studio-spec — Spec 验证与变更分级服务
- 规模：11 个源文件 / 2254 行（4 个测试文件）。
- 导出面：SpecValidatorService 及三层验证器、ChangeAnalyzerService、ChangeHistoryService、GateCheckerService + 三类 types + gate 常量。
- 消费方式：仅 apps/api/src/modules/specs/routes.ts:5-12，只用 Change* 与 Gate* 六个符号。
- SpecValidator 集群（spec-validator.service.ts 189 + architecture-validator 123 + api-validator 117 + acceptance-validator 133 = 562 行，另有 270 行测试）除 index 导出外零消费（见 §4）。

### studio-task — pipeline 时代任务队列（Redis 风格 MemoryStore 队列 + HTTP worker）
- 规模：10 个源文件 / 1081 行（6 个测试文件）。
- 导出面：`TaskQueue`/`taskQueue`、`TaskWorker`/`taskWorker`、types、cli（queue/run/retry/clean，mock 实现）。
- 消费方式：apps/api 两处且均为"遗留接口"——index.ts:417-419 仅在 `STUDIO_TASK_QUEUE_ENABLED=true` 时停止队列（**默认关闭**，index.ts:12-14 注释明示"pipeline 时代队列，全库无存活生产者…包暂不删除——12 个 task-queue 测试为预存失败"）；modules/executions/routes.ts:225 的 `GET /worker/status` 调 `taskWorker.getStatus()`。另被 studio-monitor 依赖（见 §2）。

---

## 2. 跨包依赖图

实际 import（非测试代码，按 `grep "from '@dommaker/…'"` 统计）：

```
studio-shared      → @dommaker/harness（外部包，15 处）
studio-skill       → （无跨包 import）
studio-agent       → studio-shared（主入口 11 + /node 6 + /harness 1 + /harness/hooks 2）、studio-skill（1 处）
studio-audit       → studio-shared（2 处：FileStore/logger）
studio-capability  → studio-shared（1 处：FileStore/logger）、@dommaker/harness（1 处：getRegistryPath）
studio-monitor     → studio-shared（1 处）、studio-task（1 处）
studio-notification→ studio-shared（2 处）
studio-spec        → studio-shared（4 处）
studio-task        → studio-shared（2 处）
```

- **无循环依赖**：依赖方向严格为 shared/skill 在底层，其余包单向向上。
- **声明了但未使用的依赖（package.json 死依赖）**：
  - `studio-skill/package.json` 声明 `@dommaker/harness` 与 `@dommaker/studio-shared`，但 src（含测试）无任何对二者的 import —— 两个依赖均可删。
  - `studio-spec/package.json` 声明 `@dommaker/studio-notification`，全包唯一出现是 architecture-validator.ts:112 的一个字符串字面量（硬编码 package 名白名单），非 import —— 依赖可删。
- **"为一个小函数依赖整个包"型依赖**：
  - studio-agent → studio-skill：仅 runner-params.ts:17 用 `skillLoader`（load + formatForPrompt 两个方法）。考虑到 apps/api 也直接用 studio-skill，此依赖合理但耦合面极小。
  - studio-monitor → studio-task：仅 health-monitor.ts:2 用 `taskQueue`（getStats/failTask 三处调用）。而 studio-task 本身默认关闭（见 §5），这是一条"死包喂死包"的边。
  - studio-capability → @dommaker/harness：仅 capability.service.ts:12 用 `getRegistryPath()`；调用方 routes.ts:5 本就已从 harness 取 `REGISTRY_PATH` 并经构造函数注入（routes.ts:35），`getRegistryPath` 兜底分支实际不会走到 —— 可内联删除。

---

## 3. 大文件剖析

### 3.1 studio-shared/src/file-store.ts（1334 行）

内部职责划分（注释自带 `═══` 分段，缝是现成的）：

| 区段 | 行号 | 内容 |
|---|---|---|
| 类型定义 | 32–218 | 8 组 interface（Profile/State/Channel/Message/WorkUnit/Requirement/Evolution）+ LockTimeoutError |
| IO 原语 + 文件锁 | 223–347 | readJson/writeJson（原子写）/appendJsonl/readJsonl/withLock（mkdir 锁） |
| 路径生成 | 349–381 | 各实体文件路径 |
| AgentProfile CRUD | 383–465 | 含一次性迁移 `migrateChannelsEncoding`（440） |
| RuntimeState CRUD | 467–527 | |
| Channel CRUD | 529–582 | |
| ChannelMessage（JSONL） | 584–742 | 版本快照/增量读/tombstone 软删/跨频道扫描 |
| WorkUnit event sourcing | 744–895 | events.jsonl + index.json 快照 + claim/upsert/remove（锁保护） |
| Requirement | 897–990 | REQ 序号分配 + CRUD |
| Evolution | 992–1085 | EP 序号分配 + CRUD（注释 L993 自认"复制 Requirement 模式"） |
| Markdown 文档 | 1087–1206 | readDoc/writeDoc/buildIndex/queryIndex/listDocs/findByField/bumpVersion/appendChangelog |
| 工具函数 | 1209–1334 | parseChannels/stringifyChannels/frontmatter 解析序列化/ID 格式化/sleep/applyFilter |

可行拆分缝：types / json-io+lock / agents(profiles+states) / channels(+messages) / workunits / requirements+evolution / markdown-doc，七个文件即可，均为方法平移、零行为变更。

明显重复逻辑：
- **Requirement 段（917–990）与 Evolution 段（1012–1085）几乎逐行复制**：`listExisting*Seqs`、`allocate*Seq`、`get/list/update` 五对方法结构完全同构，仅目录名、ID 正则（`REQ-` vs `EP-`）、过滤字段不同。注释 L993 自认复制。可合并为泛型"带序号的 JSON 文档集合"实现（属接口内部重构，方法签名可保持不变）。
- `listProfiles`（391）/`listStates`（476）/`listChannels`（537）三个"readdir + 逐文件 readJson + ENOENT 容错"几乎同构。
- `resolveActiveMessages`（625）与 `getMessageById`（722）各自实现了"按 id 去重取最新 + 过滤 deleted"。

死/半死方法（生产零调用，仅自身测试覆盖）：
- `rebuildIndex`（785）——生产 0 调用，仅 file-store.test.ts 8 处。
- `queryIndex`（1141）——仅被同文件 `findByField` 调用 + 测试。
- `findByField`（1175）——生产 0 调用。
- `bumpVersion`（1182）——生产 0 调用。
- `migrateChannelsEncoding`（440）——一次性数据迁移，仅 scripts/cleanup-runtime-data.ts:302 调用；F3 迁移完成后可连脚本一起删。
- 对照：`buildIndex`（1122）有 1 个生产调用（apps/api/src/modules/knowledge/resolution.service.ts:351）；`appendChangelog` 经 sdd-utils.ts:304 被 2 个 scripts 调用——保留。

### 3.2 studio-capability/src/services/company-mcp-pool.ts（574 行）

- 内部职责：类型定义（11–132）→ `CompanyMCPPool` 类：CRUD（147–325）、角色权限（332–372）、工具缓存（379–397）、使用统计（404–468）、系统级模板（475–486）、私有存储（490–511）、校验（516–528）、加解密（533–567）→ 工厂函数（572）。
- **整文件是占位实现**：`private cache = new Map()`（L137）纯内存 Map，无持久化、进程重启即丢；`encryptEnvVars` 是 base64 伪加密（L534 注释自认"占位符"）；`getMCPTools` 注释 L386"这里应该调用实际的 MCP 客户端…简化实现"；构造函数 `_config` 参数未使用；`CompanyMCPPoolConfig` 是空接口（L131）。
- **消费验证：`CompanyMCPPool`、`createCompanyMCPPool` 全仓零引用**（除包内 index.ts 导出），无任何测试。**574 行整体为死代码，是最干净的整文件删除项。**

### 3.3 studio-capability/src/services/capability.service.ts（526 行）

- 内部职责：类型 + 常量（17–62）→ CRUD（74–254：capPath/generateId/scanAll/create/createMany/getById/getByName/list/update/delete）→ Registry 同步（259–322）→ 统计（327–354）→ **AS-014 市场功能（356–527：publishToMarket/listMarket/purchase/getMarketStats，约 170 行）**。
- 可行拆分缝：CRUD+存储 / registry-sync / market 三块；但鉴于市场块整体无调用方（下条），优先是删而非拆。
- 明显问题：
  - **市场四方法生产零调用**：routes.ts 调用的 10 个方法不含任何一个市场方法；全仓 grep 无其他调用方。
  - **`purchase()`（430–495）是坏的**：L452-454 FIXME 自认 roleCapability 未迁移，用 `(this.fileStore as any).roleCapability?.findFirst` —— FileStore 无此属性，optional chaining 使 `existing` 恒为 undefined、`roleCapability?.id` 恒为 `''`，即购买永远"成功"但关联记录永不落库。死代码 + 静默错误语义，删除无风险。
  - `scanAll`（84）每次全目录扫描，`getById`/`update`/`delete`/`list`/`getStats` 全都 O(N) 重复扫描（性能注意项，非清理项）。

### 3.4 studio-agent/src/services/runner-execution.ts（510 行）

- 结构：**单函数文件** —— `executeSessionLoop`（59–510，约 450 行一个函数）+ `RunnerExecutionState` 接口（50）。文件头注释（L1-9）说明它本身就是从 agent-runner.ts 按职责拆出的模块，"零行为变更平移"。
- 函数内阶段（行号为函数内偏移）：workspace 解析与前置检查（76–103）→ harness 配置传播 + 依赖缓存（104–118）→ Iron Laws 检查（119–138）→ SDD task 数据解析 + REQUIREMENTS/契约测试落盘（139–163）→ session 循环（164–500）：每轮含文件桥接确认、进度读取、prompt 构建、cli-adapter spawn、stream-json 解析、失败处理与 RKB 提示（266–304）、首轮零产出快速失败（311–355）、卡死检测（356 起）。
- 可行拆分缝：准备段（~76–163）已是"调用六个 helper 的编排"，可提为 `prepareExecutionContext()`；session 循环体（每轮迭代 ~164–360）可提为 `runOneSession()`；失败/卡死判定策略（311–500）可提为独立函数。均属函数内抽取，不动导出签名。
- 重复逻辑：无逐字重复（runner-output.ts 注释 L7 说明此前与 runner-lightweight 的两处副本已在 Wave-4 抽到 runner-output 共用）。

### 3.5 studio-task/src/services/task-worker.ts（507 行）

- 内部职责：生命周期（start 63–103 / stop 203–207 / poll 212–240）→ 事件订阅处理（handleProgressEvent 108–163 / findStudioExecution 168 / reloadConfig 180）→ 任务执行（launchTask 245 / executeTask 256 / buildPrompt 278 / runAgent 304，经 HTTP 调 `AGENT_RUNTIME_URL` 默认 `http://localhost:3001` 的 agent-runtime）→ 完成等待（waitForCompletion 342 / pollExecutionStatusOnce 394，事件优先 + 60s 后 fallback 轮询）→ 事件发布（publishThinkingStream 464 / publishStepEvent 488）→ getStatus（443）。
- 可行拆分缝：event-subscription / http-runtime-client / worker-loop 三块即可，但**该包整体默认关闭（§5），拆分优先级低于"决定去留"**。
- 备注：L12 `@ts-ignore` 引入 node-fetch v2；L45/166/178 有 🆕 注释（与仓库注释风格不一致）。

### 3.6 studio-agent/src/services/worktree-resolver.ts（470 行）

- 内部职责：git 基础（getDefaultBranch 21 / createWorktree 42 / writeGitExclude 86）→ 三级 workspace 解析（resolveWorkspace 119–155）→ harness/Claude 配置传播（propagateHarnessConfig 160–224）→ 依赖缓存（extractExecError/computeLockfileHash/findLockfile/detectPackageManager 229–284 + ensureDeps 286–373，lockfile hash → hardlink cp -al 缓存）→ WU/PMO worktree（WuWorktreeInfo 377 / ensureWuWorktree 389 / cleanupFailedWuWorktree 417 / ensureBranchExists 433 / ensurePmoIntegrationWorktree 453–470）。
- 可行拆分缝：git-worktree 基础 / harness 配置传播 / deps-cache / wu-pmo-worktree 四个文件；导出符号不变。
- 消费验证：`createWorktree` 无包外直接调用（仅被同文件 resolveWorkspace:153、ensureWuWorktree:406 内部使用，包外仅在注释中提及）；`ensureWuWorktree`/`ensureBranchExists`/`getDefaultBranch`（agent-loop.ts:12）、`ensurePmoIntegrationWorktree`（merge-on-review-pass.ts:35）、`resolveWorkspace`/`propagateHarnessConfig`/`ensureDeps`（包内 runner-execution/runner-lightweight）均有活跃调用。
- 备注：propagateHarnessConfig L185 使用 `require.resolve`（ESM 包内 CJS 残留写法，非清理优先级）。

---

## 4. 包内死代码与冗余（逐项可执行清理清单）

### 4.1 整文件/整模块级死代码（生产零调用，已 grep 验证）

| 项 | 位置 | 规模 | 证据 |
|---|---|---|---|
| CompanyMCPPool 全模块 | studio-capability/src/services/company-mcp-pool.ts | 574 行 | 除 index.ts 导出外全仓零引用、零测试；内存 Map 占位实现 |
| 能力市场四方法 | capability.service.ts:356–527 | ~170 行 | routes.ts 不调用；purchase() 自带 FIXME 且逻辑恒空转 |
| AgentCompleter 全模块 | studio-agent/src/services/agent-completer.ts + 对应测试 | 229 + 170 行 | 全仓仅自身、自身测试、index 导出三处引用 |
| AuditChain 全模块 | studio-audit/src/services/audit-chain.ts | 446 行 | 全仓零引用（无测试、audit-service 不用、apps 不用），仅 index.ts 导出 |
| SpecValidator 集群 | studio-spec/src/services/{spec-validator.service,architecture-validator,api-validator,acceptance-validator}.ts + spec-validator.service.test.ts | 562 + 270 行 | specs/routes.ts 只用 Change*/Gate*；集群除 index 导出与自身测试外零引用 |
| matchIntent | studio-skill/src/intent-router.ts + 测试 | 22 + 72 行 | 除 index 导出与自身测试外零引用 |
| studio-skill/src/definitions/ | index.ts 内容仅 `export {}` | 1 行 | 空 stub 目录 |
| FileStore 四方法 | file-store.ts: rebuildIndex(785)/queryIndex(1141)/findByField(1175)/bumpVersion(1182) | ~90 行 | 生产零调用（queryIndex 仅被 findByField 调），仅 file-store.test.ts 覆盖 |
| studio-shared 死工具六件 | utils/parallel-executor.ts(211)、utils/scheduler.ts(150)、utils/concurrency-control.ts(65)、utils/error-file-extractor.ts(42)、utils/git-utils.ts(49)、utils/event-emitter.ts(67) | 584 行 | 包内外均零引用（仅 utils/index.ts 再导出）；event-bus.ts 直接用 node:events 而非 event-emitter.ts |
| utils/events-dir.ts | studio-shared/src/utils/events-dir.ts | 22 行 | 生产零调用；唯一引用是 monitor-probes.test.ts:31 对一个未使用导出的**陈旧 mock** |
| llm-client | studio-shared/src/llm/llm-client.ts + 测试 | 177 行 + 测试 | 全仓零引用（stream-json-parser 有调用方，llm-client 没有） |
| constants 两件 | studio-shared/src/constants/responsibility-chain.ts(339)、constants/stage-definitions.ts(268) | 607 行 | 包内外零引用、零测试；apps/api/src/modules/capabilities/routes.ts:64 甚至本地重定义了同名 `STAGE_NAMES` 而不导入 |
| 三个 mock CLI | studio-audit/src/cli/*（178 行+测试）、studio-notification/src/cli/*（130 行+测试）、studio-task/src/cli/*（151 行+测试） | ~460 行 | bin 已注册但全仓无任何调用；实现为硬编码 mock 数据（如 studio-audit/src/cli/log.ts:4-11），与真实服务未接线；仅各自 cli 测试存活 |

### 4.2 package.json 死依赖
- studio-skill：`@dommaker/harness`、`@dommaker/studio-shared`（全包无对应 import）。
- studio-spec：`@dommaker/studio-notification`（仅字符串字面量）。

### 4.3 重复实现的工具
- **frontmatter 解析三份**：studio-shared/src/file-store.ts:1281 `parseFrontmatter`、studio-shared/src/utils/sdd-utils.ts:105 `parseSddFrontmatter`（SDD 专用类型版）、studio-skill/src/loader.ts:37 私有 `parseFrontmatter`（Skill 版；loader.ts 未 import 共享版——studio-skill 声明的 studio-shared 依赖正可借此用上）。
- **ID 生成同一模式五处**：`prefix_${Date.now()}_${Math.random().toString(36)…}` —— audit-service.ts:137、audit-chain.ts:364、capability.service.ts:80、company-mcp-pool.ts:152/196、notification-service.ts:185、harness/hooks/audit.ts:50（另有 uuid/randomUUID 在别的包混用，无统一口径）。
- **sleep 两份**：file-store.ts:1260 私有 `sleep`；task-worker.ts:237/379 内联 `new Promise(resolve => setTimeout(...))`。
- `STAGE_NAMES`：studio-shared/constants/responsibility-chain.ts:142 与 apps/api/src/modules/capabilities/routes.ts:64 各一份（前者根本无人用）。

### 4.4 废弃注释与过渡残留
- studio-shared/src/harness/index.ts:83–162 五个 `@deprecated` Law* 别名方法（getLawList/getLawById/checkLaw/checkAllLaws/checkMultipleLaws）——仍被 apps/api/src/modules/harness/iron-laws.routes.ts:10/20/36/39/52 使用，调用方全在仓内，可一次改成新名后删除别名。
- studio-shared/src/file-store.ts:36 `channels` 字段标注 @deprecated（过渡期保留可读）。
- studio-agent/src/services/output-capture.ts:192 `[DEPRECATED] GoalExecution 已迁移至 WorkUnit`；agent-runner.ts:39 `@deprecated Use StreamEvent`。
- studio-capability/src/services/capability.service.ts:452 FIXME（purchase 坏掉，见 §3.3）。
- studio-spec/src/services/architecture-validator.ts:15 TODO(spec4-followup)；其 L109-118 硬编码有效 package 白名单（含已死的 studio-prisma 引用），随集群一起删。
- apps/api/src/index.ts:12-14 TODO(cleanup) 明示 studio-task 可删（见 §5）。

---

## 5. 整包存疑

| 包 | 结论 | 证据 |
|---|---|---|
| **studio-task** | **实质整包待删** | apps/api/src/index.ts:12-14 官方注释："pipeline 时代队列，全库无存活生产者；默认关闭…包暂不删除——12 个 task-queue 测试为预存失败"。生产触面仅剩 `GET /worker/status`（executions/routes.ts:225）与默认关闭的关闭钩子。task-worker 还依赖一个外部 agent-runtime HTTP 服务（task-worker.ts:56，默认 localhost:3001），仓内无此服务 |
| **studio-monitor** | **实质整包待删** | 唯一消费者 apps/api/src/index.ts:15 只 import 不启动：`startHealthMonitor` 全仓零调用，仅 shutdown 时对从未启动的实例做 no-op stop（index.ts:413）。其唯一跨包依赖是指向半死的 studio-task |
| studio-capability | 半包可删 | company-mcp-pool 574 行全死 + 市场方法 ~170 行全死 ≈ 全包 67% 死代码；剩余 CapabilityService CRUD/同步被 routes.ts 活跃使用 |
| studio-audit | 近半包可删 | audit-chain 446 行全死 + mock cli 178 行 ≈ 全包 63%（AuditService 本体活跃） |
| studio-spec | 约 1/4 可删 | SpecValidator 集群 562 行死代码；Change*/Gate* 活跃 |
| studio-skill | 本体健康 | 仅 matchIntent、definitions/ 空 stub、两个死依赖可清 |
| studio-agent | 本体健康 | 仅 agent-completer 399 行（含测试）死代码 |
| studio-shared | 本体健康但赘肉最多 | 死工具/死常量/死 llm-client/死 FileStore 方法合计 ~1500 行可清（§4.1） |
| studio-notification | 本体健康 | 仅 mock cli ~130 行可清 |

**清理顺序建议**（风险从低到高）：
1. 零引用整文件：company-mcp-pool、agent-completer、audit-chain、intent-router、spec-validator 集群、shared 死工具六件 + events-dir + llm-client + constants 两件、三个 mock CLI（连带各自测试与 index 导出行）。
2. 零调用方法与死依赖：FileStore 四方法、capability 市场四方法、studio-skill/studio-spec 的 package.json 死依赖。
3. 调用方在仓内的收尾：iron-laws.routes.ts 改新名后删 Law* 别名；monitor-probes.test.ts 陈旧 mock 随 events-dir 一起清。
4. 整包决策（需规划者拍板）：studio-task + studio-monitor 联动下线（删除 index.ts:15/413-420 的引用、executions/routes.ts 的 /worker/status 端点、health-monitor 对 taskQueue 的依赖）；migrateChannelsEncoding 随 cleanup-runtime-data.ts 一次性脚本退役。

---

## 附：验证方法

所有"零引用"结论均经如下命令模式验证（2026-08-06，工作区 /root/projects/studio）：
`grep -rn "<符号>" --include='*.ts' apps packages scripts bin | grep -v node_modules | grep -v /dist/`，再分别剔除/保留 `__tests__`、`*.test.ts` 以区分生产与测试引用；dist/*.d.ts 命中视为构建产物噪声忽略。大文件行号引用以当前工作区源码为准。
