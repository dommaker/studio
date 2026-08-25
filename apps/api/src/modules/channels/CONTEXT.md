# apps/api/src/modules/channels

### 职责

Channel 驱动管线入口：@Analyst 触发 → RequirementsDoc 生成 → Goal 创建 → 执行管线。
包含 Analyst 全流程（scout+synth / direct 两条路径）、ContractTest 验证、SDD 文件写入。

### 核心导出

| 模块 | 导出 | 职责 |
|------|------|------|
| analyst-trigger.service.ts | `AnalystTriggerService.trigger()` | 管线入口：DB 去重 → LLM 分析 → 验证 → SDD → 卡片 → 自动执行 |
| analyst-executor.ts | `runClaudeCode()`, `sanitizeJson()`, `validateAnalystOutput()` | Claude Code 执行 + 4 层 JSON 解析链 + 输出验证 |
| analyst-knowledge.ts | `perInvocationOutputFile()`, `loadKnowledge()`, `saveKnowledge()` | Analyst 输出路径 + knowledge.md 读写 |
| analyst-prompt.ts | `buildAnalystPrompt()`, `buildRevisionPrompt()` | Analyst prompt 构建（含 scout/synth/revision） |
| channel-message.service.ts | `channelMessageService` | 消息创建/更新/删除 + event 发布 |
| contract-test-validator.ts | `validateContractTests()` | Layer 1-3 契约测试质量检查（AC coverage / TS syntax / import path） |
| contract-test-red-check.ts | `verifyRedState()` | Layer 4 RED 状态验证 |
| channel.routes.ts | Express router | Channel API 端点（消息/start_execution/cancel 等） |

### 依赖关系

**本模块依赖**：
- `@dommaker/studio-shared` — FileStore（Channel / RequirementsDoc 等文件存储，已替代 studio-prisma DB）, logger, modelGateway, eventBus, toKebab
- `agents/monitor-agent` — 管线监控

**被依赖**：
- `cli/studio-cli.ts` — CLI 入口调用 trigger()

### 注意事项

- **输出文件路径**：`perInvocationOutputFile()` 返回绝对路径（ANALYST_DIR 基于 REPO_DIR）。scout 路径用相对路径，session-manager 有 worktree fallback
- **JSON 解析链**：4 层（sanitize → code-fence → regex → LLM repair），outputText = "DONE" 无 JSON，文件是唯一数据载体
- **DB 去重**：同 channel 24h 内有有效 RequirementsDoc → 直接复用（0 token）
- **outputFile 唯一性**：Claude 通过 Write tool 写文件，stdout 只有 "DONE"。文件丢失 = 数据丢失
- **鉴权分层（2026-07-24 收紧，姿态 A）**：`/api/v1/channels` 在 PUBLIC_API —— GET（`/`、`/:id`、`/:id/messages`）保持**匿名公开**（Lurk Wall 围观本体，不要再给 GET 加中间件）；10 条写端点（建频道/发消息/删频道/archive/restore/PATCH/members/convert-to-task×2/card-decision）= `requireAuth()+requireNotGuest()`。注意 `POST /:id/messages` 经 @mention 派单/恢复挂起 WU 可直接触发 agent 执行与 LLM 消耗，是收紧前最危险的匿名入口。requirements-docs PUT 同为 requireNotGuest
- **消息路由优先级**（`message-routing.ts` routeMessage）：`replyToId` 线程回复（继承父消息 workUnitId；**#327 起父消息不在热层——已归档/不存在不可区分——降级放行**：帖子成立、replyToId 保留、workUnitId 继承失效落 null、不整帖抛错）→ `@mention` 派单（建 WorkUnit，`metadata.creationMode='mention'`；§9.5 只匹配本频道 members，members 为空回退全量 active profile）→ 纯文本仅存储。mention = 纯文本 `@name`（无结构化 id），检测与 scope 剥离用 Unicode 正则 `[\p{L}\p{N}_-]+/u`；手打中文连写无空格（`@开发你好`）匹配不到——前端补全插入带尾随空格，主路径不受影响。归属解析出 PMO 项目时创建期落 `metadata.pmoId`（2026-08 归因统一 canonical key；原 `ownershipProjectId` 废弃不再写入，读取侧同级兼容）
- **成员绑定**：`channel.members`（config.json 内 JSON 字符串数组）是成员关系唯一事实源，`AgentProfile.channels` 已废弃（启动时幂等迁移）；PATCH `/:id/members` 合并 add/remove 后整体回写；删除 profile 时由 AgentProfileService 反向清理各频道 members 悬空引用
- **系统消息唯一发布路径（2026-08-06）**：`channelMessageService.createAgentMessage` 是唯一会发 `channel.message_sent`（eventBus + SSE）的入口；WU 线程系统消息（anchor + pmoId + atHuman）一律经 `workunit/wu-messenger.postWuSystemMessage` 委托到此——禁止再裸 `fileStore.appendMessage` 发系统消息（不发事件 = 通知铃不响、频道页不实时）。`message-routing` 的 @studio 改派/归属提问两处已迁移；`MessageRecord` 类型自本模块导出供 messenger 返回类型使用
- **@文件引用前半链路（#281，决策 #249/#257）**：`file-ref-vocabulary.ts` —— 候选集 = 频道相关工程（频道默认工程 ∪ 本频道 REQ 挂接 PMO 的 gitRepo+deliveries 多腿 ∪ 杂务 PMO，尾斜杠归一去重，频道内最近 WU metadata.workspaceRoot 优先；UX 划界非安全边界，实时计算不动 project-discovery），词表 = 各仓 `git ls-files` + 进程内存缓存（60s TTL，单仓失败空词表不拖垮整体）。只读端点 `GET /:id/file-vocabulary`（随 GET 族匿名公开）。发送带 `files:[{repo,path}]`（repo 绝对路径同 PMO gitRepos 形，path 原样相对路径，无行范围）→ routeMessage 路由时存在性校验：有效引用写消息 `meta.files`（mention 纯文本不动），失效引用剔除 + Studio 系统播报 + `channel:file_refs_dropped` 事件（reason=not-found/not-in-candidate-set，dropped 封顶前 5 条 + droppedCount 全量，D9 尺寸纪律）。composer（web ChannelInput）@弹框统一分组（上 Agents 下 Files），文件候选 = 词表后缀精确匹配，选中插入纯路径文本（不带 @ 防 mention 正则误吃），发送仅上送正文仍含其路径的引用。后半链路 API 侧已落地（#285）：kept refs 写 WU `metadata.fileRefs`（@mention 与决策 12 channel-default 两条建 WU 路径，仅在有有效引用时写字段；线程回复不建 WU 不动）；归属链新 rung（ownership-resolver.ts）= 显式 workspaceId > REQ 继承 > 文件引用（全部引用尾斜杠归一后同仓 → `source=file-refs`，workspaceRoot=归一 repo；跨多仓不参与、落下一 rung；空数组等同无引用）> 频道默认 > none；prompt 注入段「## 引用文件」（prompt-composer.ts files 段：稳定前缀最末、knowledge 段之后，定额 400 参与池内余量共享；内容 = 每引用一条块（绝对路径 repo/path + 本工程内相对路径/「位于本工程之外」标注）+ 段尾固定只读约束行；块级截断保注入序前缀 + 段尾「另有 N 条引用未注入」，病态超预算空段不注入；`prompt:section_trimmed` payload 增 keptCount/droppedPaths(≤5)/droppedCount；截断时首步（stepCount 缺失或 0）向 WU 频道播报「引用文件较多，已注入前 N 条」一次，best-effort）；agent 侧 chip 见本票 web 侧
- **顶栏默认工程正名 + 当前 PMO chip（#272，决策 #251 Q2'/Q6）**：「默认工程」= 本地 repo（`channel.defaultPath`，顶栏下拉数据源 `/projects/discover`，非 Admin 可用），「默认执行机器」= 远程 Workspace（`defaultWorkspaceId`，正名挪设置区归 #286）——两者分家，根 CONTEXT.md 词汇表有词条。归属链接通：ownership-resolver 新增 rung `channel-default-path`（defaultPath 直接作 workspaceRoot，位于文件引用之后、defaultWorkspaceId 之前）；file-ref-vocabulary 候选集默认工程改读 defaultPath（legacy defaultWorkspaceId 根保留）。「当前 PMO」chip 派生不落库（`current-pmo.ts` `deriveChannelCurrentPmo`：本频道最近挂接 REQ（seq 大→小）所属 PMO → 杂务 PMO 反推 → null；端点 `GET /:id/current-pmo` 匿名公开，返回 `{id, pmoNumber, title, gitRepos}`，多仓 tooltip 列 gitRepos）。创建频道表单合并为 web `CreateChannelForm` 单一实现（ChannelListPage/ChannelRail 共用），含可选默认工程（可留空），POST /channels 收 `defaultPath`（空串归一 null）
- **文件 chip WU 文件集优先层（#285 AC4 补齐，2026-08-20）**：per-WU 产出/修改文件集查询面 = `workunit/wu-changed-files.ts listWorkUnitChangedFiles`（session:start 事件 payload.workUnitId（#174）→ sessionId 集合 → file:change 事件（studio-agent output-capture 对 Write/Edit 发射）payload.path 绝对路径，去重保序；读失败/无数据 → 空数组绝不抛出），端点 `GET /workunits/:id/changed-files` 匿名只读。注意路径通常是 per-execution worktree 内绝对路径（非候选仓路径），file:change 无 envelope level 按信号类保留（热 30 天→月度归档），过期自然降级。web 侧 `fileChipMatch.matchFileRefToken(token, vocabulary, wuFiles?)` 两层命中即停：WU 集唯一命中 → FileRef 按命中边界从绝对路径切出（不映射回候选仓）；歧义 → 纯文本不回退；无命中 → 候选集词表。ChannelDetailPage 按 agent 消息 distinct workUnitId 逐个拉取缓存（wuChangedFiles state + fetched ref），经 ChannelMessageItem prop 透传。注入段「跨仓只读」固定行已对齐 #285 票体原文（去掉自加的「（workspaceRoot）」与 `**` 加粗）
- **删除频道兜底（B2-012）不再直触 WU 存储（2026-08-06，Card 9）**：DELETE `/:id` 的 WU 重挂委托 `WorkUnitService.rebindSourceChannel`（解析 metadata 按 `context.sourceChannelId` 字段相等匹配 + appendEvent 留痕）——原为路由内 `metadata.includes(channelId)` 子串匹配（可被其它字段误伤）+ 裸 `upsertSnapshot`（无事件、手置 updatedAt）。路由只保留：兜底 rnd 频道查找/创建、SDD frontmatter 迁移（non-blocking）、频道删除、响应形状 `{ deleted, fallbackChannelId }`
- **channel.message_updated 负载带全量本体（#311，ADR 2026-08-24 D1/D2）**：`updateMessageMeta`/`updateMessage` 两发射点（eventBus + SSE 同负载）additive 增 `message` 字段 = 落库后完整 shaped message（与 `channel.message_sent` 同源 `shapeMessageData()`）；顶层既有字段语义不动——注意 `updateMessage` 顶层 `content`/`meta` 仍是**增量**（缺省 undefined），合并后全量真值读 `message.meta`。消费端迁移到读 `message` 已落地（#315）；`createdAt` = 不可变诞生时刻（#317，ADR 2026-08-24 message-createdat-immutable）——两更新方法不再 bump，SSE 原位替换与 REST 刷新归位恒一致；#332 起 `createFromMessage`/convert-to-task 两条关联 WU 的直写 append 路径同口径（不 bump，否则 agent-loop `msg.createdAt > wu.updatedAt` 新回复检测把已转换消息误判为新回复）
- **人审卡决策端点（#278，决策 #250 D2）**：`card-decision.service.ts` + `POST /:id/messages/:messageId/card-decision`（human-only，不复活 AC-A5 删掉的通用 actions）。仅服务 auditor_suggestion 卡：confirm → 本频道建 `type:task`/`status:'unassigned'` 工单（metadata.creationMode='card-decision'，description = 建议详情 + 原卡链接）；reject → 仅留痕。幂等守卫：已 decided / 非 auditor_suggestion → 400。状态经 `updateMessageMeta` 回写 meta.status（confirmed/rejected + workUnitId），自带 eventBus + SSE `channel.message_updated`。requirements_doc / knowledge_confirm 历史产卡链已删，前端已只读化（按钮区隐藏 + 「该确认入口已下线」淡注），无对应端点。
- **消息分页端点（#319，2026-08-24；#327 穿透，2026-08-25）**：`GET /:id/messages` 的 `before` 游标 = 锚点**消息 id**（不再是 timestamp——同毫秒多条会漏/重），分页下沉到 `FileStore.queryMessagesPage`（存储层切片）；锚点 id 不存在时返回空页 + hasMore=false。前端 `useChannelEvents.loadMore` 传 `oldest.id`。#327 起穿透冷热边界：首页热层不足 limit 即从冷层补满（热全空也直接出冷，历史永远在），热层见底后游标链入 `archive/messages-YYYY-MM.jsonl` 冷文件继续往回翻（新→旧逐月），跨冷热同毫秒不漏不重、同 id 新→旧先见为准；前端无限滚动无感续历史，「往上翻」= 查看历史的唯一入口。消息存储压实/归档机制与 id 新鲜度契约见 studio-shared CONTEXT.md
- **消息热层/冷层术语（#327，2026-08-25）**：热层 = `channels/{id}/messages.jsonl`（在跑的活）；冷层 = `channels/{id}/archive/messages-YYYY-MM.jsonl`（超龄归档，纯可读永不删除）。**归档** = 定期 sweep 把超龄活消息热→冷（WU closedAt + 30 天 / 闲聊 createdAt + 30 天）；**穿透** = `queryMessagesPage` 分页跨冷热链式翻页（其余查询面 queryAllMessages/getMessageById/listByWorkUnitId/observe/metrics 全部热只读）；**解冻** = WU reopen（closed→unassigned）自动把该 WU 冷消息搬回热层。已归档消息只读：编辑/删除/convert-to-task 走既有 not-found 路径（明确 4xx），replyTo 父在冷层引用降级不崩
