# packages/studio-shared/src

### 职责

本目录是 Agent-Studio 的前后端共享库，提供 CLI 框架、配置管理、常量定义、事件总线与文件存储等通用基础设施，为 apps/api 等多个上层模块提供复用的工具与类型。

### 核心导出

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
| `createSettledTracker` / `SettledTracker` | utils/settled-tracker.ts | #228 确定性等待原语（#158 先例抽取）：fire-and-forget 异步链（事件订阅消费 / best-effort 收尾）的在途登记 `track` + `waitForSettled` 等待（while 循环兜底级联），供测试替代盲等；消费方：pmo/progress-rollup、workunit.service（reviewPassed 收尾）、agents/loop/review-dispatcher、pmo/analysis-handoff、pmo/map-opening、pmo/spec-materialization（后两者 2026-08-26 补：测试删目录前等在途链落定，消 /tmp 复活竞态） |
| `setReadMetricsSink`, `runWithLoopLabel`, `readMetricsBegin`, `emitReadMetric` | read-metrics.ts | #323 读口量化测量 sink：模块级 sink 默认 null（关闭 = 读口一次 if 外零开销）；`runWithLoopLabel` 基于 AsyncLocalStorage 做循环归因（无 label → 'unlabeled'）；file-store 四读口（readJson/readJsonl/readIndexForQuery/readdirCached）内计时埋点（statMs/readParseMs/cloneMs/cacheHit），锁内裸读路径不埋 |

### 依赖关系

**上游（本目录依赖）**
- Node.js 内置模块: `fs`, `path`, `os`, `events`, `crypto`
- 第三方库: `yaml`

**下游（依赖本目录的模块）**
- `apps/api` 全套模块（daemon、middleware、modules、index、cli 等）广泛引用本目录的 CLI 框架、配置管理、事件总线及 file-store 类型

### 注意事项

- CLI 命令注册表为全局单例，测试后需调用 `clearCommands()` 清理
- 配置优先级：环境变量 > `~/.studio/config.env` > 默认值，且仅当环境变量未设置时才加载 config.env
- 数据根：`studioDir()`（config/studio-dir）= `STUDIO_HOME` 或 `~/.studio`；config.env 与 `STUDIO_DATA_DIR ??=` 钉值均走它。dev 启动（scripts/dev/start.sh、apps/api dev script）默认 `STUDIO_HOME=~/.studio-dev`，prod systemd 显式 `/root/.studio`；非 production 指向缺省根时 `warnIfNonProdUsesProdRoot()` 落 warning（config/index.ts 初始化 + apps/api 入口显式调用，幂等）
- `studioDir()` 内含 vitest 内建模块双视图兼容层（resolveHomedir）：仓库测试对 `os.homedir` 有四种互不兼容的 mock 风格，该层保证迁移后的 SUT 在旧 mock 下仍被隔离；生产两视图恒等。测试收敛到 env 隔离后可删除（见 code-review follow-up）
- `FileStore` 使用 `flock` 目录锁（`mkdir` 原子操作）保障 claim 原子性；#169 起 withLock 持锁写 `owner.json`（pid/hostname/acquiredAt），EEXIST 时按双判据回收 stale 锁（同机死 pid / acquiredAt 或锁目录 mtime 超 30s；无属主裸锁——持锁方在写 owner.json 前被杀——按目录 mtime 超 2s 即回收，2026-08-26 flaky 修复），回收发 `lock.stale_reclaimed`、超时发 `lock.acquire_timeout`（均 warning，logger + eventBus，经 apps/api lock-events-bridge 走 dispatchMonitorAlerts 全管线）；同进程并发由进程内 per-lockDir mutex 排队不打到 mkdir
- `file-store-workunit.ts` 锁内复合原语（#170 起）：`commitSnapshot`/`commitRemoval`/`updateMetadata`/`createSnapshotGuarded`/`reconcileIndex`；#178 增 `refreshWorkUnitLease(wuId, expectedAssigneeId, expectedClaimedAt, timeoutAt)`——WU 租约心跳 fencing（claimedAt 代际令牌 + assigneeId 双比对），返回 'ok'/'lost'/'missing'，事件 data 走增量（reduce 合并语义）；#314 起心跳高频小写缓冲（每跳只做快速路 fencing + 内存 dirty 项），`flushWorkUnitLeases()` 锁内复核 fencing + status==='active' 后合并落盘（每 WU 一条增量事件 + 全量索引一次写），默认落盘窗口 `LEASE_FLUSH_INTERVAL_MS` 60s（≪5min TTL，构造注入 `leaseFlushIntervalMs: 0` = 每跳即落盘）
- `FileStore` 的 readJson/readJsonl/readdir 走模块级读穿缓存（stat mtime 校验 + 写/删精确失效，工单 26 A1）；缓存命中返回结构克隆，调用方 mutate 返回值不会污染缓存；#314 起 `getIndex` 也走该缓存（`readIndexForQuery` seam：基类缺省裸读、门面覆盖为缓存，保留撕裂抛错严格语义）；`readIndexFile` 保持无缓存（锁内跨进程正确性）——锁内读路径永不经过缓存 seam（docs/adr/2026-08-24-cache-seam-decision-rules.md 例外条款）
- `FileStore` 的 Requirement/Evolution 段共用泛型「序号分配型条目存储」实现（`SeqEntryStoreConfig`，工单 26 A2），新增同类存储应加配置而非复制段
- 事件总线支持通配符（`*`）模式订阅，Handler 异常不会影响其他监听器
- 级别常量为单一数据源，其他模块不应重复定义
- `constants/` 下各文件应保持无外部依赖（仅内部引用），便于前端复用
- `attestation.ts` 的 `deriveDisplayState()` 是 WU 展示状态唯一派生口径（F6 铁律，前后端共用）；#126（T4）起 `pending`（待确认人闸）为第七个看板列——按所有权状态原样透传；#280 起 pending 不计 needsHuman（pending 是「待确认」人闸，活未开干，与 in_review「活已干完等审查」/ done 缺 l3「活已干完等人工验收」语义不同），未知状态仍兜底 active
- `wu-display.ts` 是 WU 展示词表唯一出口（#358：7 份散装拷贝收口，经 /web 入口透出）：`WU_STATUS_LABELS`（含派生列 + failed/completed 原始状态）/ `WU_STATUS_COLORS` / `WU_TYPE_LABELS` + 阅览室文档词表（`LIBRARY_DOC_STATUS_*`）。已知有意方言未收（行为对齐另议）：RequirementChainPanel（pending 缺省、unassigned 配色 u-text-2）、ProjectPipeline（u-text-2）、mapUtils `DEP_STATUS_LABEL`（依赖图大白话文案）
- `utils/process-io.ts` 的 `execSh`（仅 /node 入口）：#171（#54 决议）起支持 `killProcessGroup`（detached spawn + `kill(-pid, SIGKILL)` 整组直杀，墙钟/静默/maxBuffer 三条杀路径同走；#68 实测 SIGTERM 杀不死孙进程）与 `silence` 静默看门狗（判据 = 距最后一次 stdout/stderr 输出间隔，warn 每段静默恰报一次、输出复位；超 killMs 杀并 reject）。未开选项的调用方行为不变
- `file-store.ts` 频道消息（#319，2026-08-24）：`appendMessage`/`softDeleteMessage` 走 per-channel `messages.lock` 互斥 + 写侧压实（每 500 写评估，≥5000 行且死行 ≥30% 时按 `mergeActiveRows` 唯一口径原子重写，只清死行）；`mergeActiveRows` 是「每 id 最新版、首现位置序、丢 deleted」归并的唯一实现（resolveActiveMessages/压实/getMessagesSince 共用）；§4.2 契约以消息 id 为锚（行号口径退役），`getMessagesSince` 锚点被压实抹除时保守返回全部活消息；`queryMessagesPage` 分页半下沉 + id 游标
- `file-store.ts` 频道消息归档（#327，2026-08-25）：`archiveChannelMessages()` 超龄活消息热→冷（`archive/messages-YYYY-MM.jsonl` 按消息 createdAt 归月；计龄锚点 = 所属 WU `closedAt`（遗产回退 updatedAt / 悬空回退 createdAt / 非 closed 保留）或消息自身 createdAt，+30 天，经 `messageArchive.{maxAgeDays,now}` 注入）；`thawWorkUnitMessages(workUnitId)` reopen 解冻回热（锁内先 append 热、后原子重写冷，热侧同 id 不重复）；`queryMessagesPage` 穿透冷热边界（链式翻页：热新→旧接冷月新→旧，无 before 热页不足 limit 从冷补满——热全空首页直接出冷，跨冷热同 id 先见为准），`queryAllMessages`/`getMessageById`/`countMessages` 等其余查询面热只读；`queryAllMessages` 自 #330 起支持可选 `channelIds` 预过滤（readdir 后跳过集合外频道不读其文件，缺省全扫——observe 巡查只扫活跃 WU 频道）；`WorkUnitSnapshot.closedAt?` 是归档计龄锚点字段（可选，旧快照缺省兼容）
- `file-store.ts` 实例目录生命周期闭环（#363，2026-08-26）：`deleteState` 删 state.json 后判空删目录——为空才 rmdir，有 profile.json 或其他文件绝不碰（`agents/<id>/` 是 profile 与 state 共享 namespace）；`sweepEmptyAgentDirs()` 一次性存量清扫（同判空条件，幂等，挂载点 = apps/api index.ts 启动段）。背景：历史死实例只删 state.json 不删目录 → 空目录无界累积拖慢 `listStates`/`listProfiles`；terminated 实例回收统一归 apps/api instance-timeout-scan（跨角色每 5min）
