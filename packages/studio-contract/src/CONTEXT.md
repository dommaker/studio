# studio-contract

## 职责

API 契约唯一正本（docs/architecture/target-architecture.md）：按域一个文件的 zod schema，定义请求/响应形状；envelope.ts 定义统一响应壳（`{ data }` / `{ data, pagination }` / `{ error: { code, message } }`）。

## 核心导出

- `envelope.ts`：`errorBodySchema` / `paginationSchema` / `dataBodySchema` / `paginatedBodySchema` / `ERROR_CODES`
- `workunit.ts`：workunit 域（首个迁移域，后续 30+ 域的模板）——WorkUnit 实体 + 各端点请求（body/query/params）+ 响应 schema 与类型
- `channels.ts`：channels 域——Channel/ChannelMessage 实体 + 派生读形状（current-pmo/pmo-candidates/suggestions/merge-target/file-vocabulary）+ 端点请求/响应；消息分页 `{ messages, total, hasMore }`（cursor 壳）
- `requirements.ts`：requirements 域——Requirement 实体（含 B3a projectId）+ chain/chain-stats 形状 + 端点请求/响应
- `pmo.ts`：pmo 域（批次 2/7）——Project（= ProjectData 全字段）/ PmoMap / DeliveryLeg / DeliveryStatus / Okr 实体 + deliver/mark-delivered/publish/parse-command/sdd 结果形状 + 端点请求/响应；deliver/mark-delivered 的 409 是错误壳扩展 `{ error: { code, message, missing?, conflictFiles? } }`（handler 自写 res，HttpError 承载不了扩展字段）
- `companies.ts`：companies 域——Company 实体 + sizes-config/hall-stats 派生读 + 端点请求/响应
- `projects.ts`：projects 域——LocalProject 实体 + exclude 清单形状 + 端点请求/响应
- `workspaces.ts`：workspaces 域——Workspace（schemaless 记录，schema passthrough 放行历史扩展字段）/ WorkspaceRuntime 实体 + 端点请求/响应；list/runtimes 的 total 随 `{success,data,total}` 壳一并退役（无消费方）
- `skills.ts`：skills 域（批次 3/7）——Skill（= SkillRecord 全字段）/ SkillManifestEntry / SkillsStats / DemotionProposal 实体 + 提案提取（scan/extract/retract）结果 + 端点请求/响应；GET / 列表平铺分页 → 统一分页壳，demotion 列表 scan 摘要兄弟键退役（均无消费方）；publish 的 promote 门禁拒绝体为错误壳扩展 `{ error: { code, message, reasons } }`（handler 自写 res）
- `specs.ts`：specs 域——SpecContent/AnalyzeChangeResult/ChangeRecord/GatePolicy/ValidateChangeResult 重声明（studio-spec 引 harness/Node 依赖，不 import）；ChangeRecord 的 Date 字段 wire 为 ISO 串；export 附件下载不进壳
- `triggers.ts`：triggers 域——TriggerConfig（condition/action 判别联合）+ 派生读（withState/costs/status/logs/fire 结果）+ 端点请求/响应；原全平铺响应统一进 `{ data }` 壳
- `evolution.ts`：evolution 域——EvolutionProposal（= EvolutionProposalData）/ ConstraintProposal / runScan 结果 + 端点请求/响应；`{ success, data }` 壳的 success 标志退役；通用提案卡端点 /review-proposals/evolution/* 归批次 4 不在此
- `knowledge.ts`：knowledge 域（批次 4/7；三套路由全迁——/api/v1/knowledge、/api/v1/knowledge-service、/api/knowledge 内部回环限定）——KnowledgeEntry（harness 条目 wire 重声明）/ UnifiedKnowledgeEntry / KnowledgeEntryItem / Resolution（studio-shared wire 重声明；tags 可能双重编码为 JSON 串，union 声明）/ KnowledgeSearchResult / KnowledgeMaintenanceResult 实体 + density/cross-session/sync-status/upsert 结果 + 端点请求/响应；GET /export 附件下载与 /knowledge-service/events 301 跳转 handler 自写 res 不进壳
- `review-proposals.ts`：review-proposal 域——状态词表（正本 + stale；status 响应值域另含 unknown）+ approve/reject/status 端点；approve 响应 data = `{ success, skipped? } + adapter data 透传`（per-kind 扩展键：productIds/archivedIds/promoted/workUnitId 等）→ schema `.passthrough()` + 手写 interface（index signature 兜扩展键）；status 的 success 标志退役；错误 `{ error: string }` 统一进壳，message 保留 `proposal-not-pending:<status>` 机器串（前端 notPendingAs 按 message 分类）
- `action-center.ts`：action-center 域——ActionCenterStateItem / ActionCenterNotification（studio-notification wire 重声明；createdAt/readAt wire 为 ISO 串或 null）+ 三段 payload；原平铺裸对象进 `{ data }` 壳
- `library.ts`：library 域——LibraryListItem / LibraryDocDetail 实体 + list query；`{ success, data }` 壳的 success 标志退役；`GET /*splat` 的 splat 段数组不进 zod params（Express 5 通配必须命名、zod params 是对象形状），query 照常校验
- `events.ts`：events 域（批次 5/7；只迁 REST CRUD——SSE /events/stream 不是 REST 契约范围，事件流 payload 保留前端本地解析器）——StudioEventItem（历史行稀疏、passthrough 放行扩展键）/ EventSearchResult（游标壳）实体 + agent-events 批量写入词表 + 端点请求/响应；D18 空 payload 拒绝保留 handler 显式判（isEmptyEventPayload 唯一口径，schema 只兜 type/source 必填）
- `transcripts.ts`：transcripts 域——TranscriptEntry / TranscriptResult 实体 + params 防路径穿越（原手写 400 收进 zod refine）
- `monitoring.ts`：monitoring 域——六端点只读聚合全形状：AgentInfo/AgentSummary（current-wu-context 的 AgentCurrentWorkUnit/AgentPmoSummary）/ MonitoringStats / FlywheelStats / OverheadStats / OverviewMetrics（D16 九组 + #456 stuck/failure24h + F6 evidence 全段声明，前端只消费六段不裁剪）/ EfficiencyMetrics（#120 缓存命中 + 段 trim）；16 个实体手写 interface + parity（前端 api/monitoring.ts 手抄全删改 import）；错误 code 由 'INTERNAL_ERROR' 归一为 INTERNAL
- `notifications.ts`：notifications 域——通知行与 action-center.ts 的 actionCenterNotificationSchema 同源（import 复用不重复声明）+ 四端点请求/响应
- `notify-channels.ts`：notify-channels 域——WecomChannelState / ClawbotChannelState（脱敏后形状）/ NotifyChannelsState / ClawbotBindStatus 状态机词表 + 端点请求/响应；`{ success, data }` 壳的 success 标志退役；502 上游失败 code = BAD_GATEWAY（errcode 透传在 message）
- `outbound-notify.ts`：outbound-notify 域——NotifyMessageType 词表（notify.service 联合类型 wire 正本）+ /send 请求/响应；type/priority 词表外值由透传收紧为 400（无消费方）

## 注意事项

- 只依赖 zod；禁止引入 Node 内置模块依赖（前端 apps/web 也 import 本包）。
- schema 即正本：改字段 = 改这里，前后端编译期同时报错，这是本包存在的意义。
- **z.infer 在本仓退化**：仓 tsconfig strict:false（strictNullChecks off），zod 的 requiredKeys 类型检测全部失效 → z.infer 所有字段变可选。消费方需要必填字段类型的实体（如 WorkUnit）用手写 interface + parity 测试（interface fixture ↔ schema 互验，见 workunit.test.ts）兜漂移；请求/内嵌结果类型 z.infer 全可选无害可继续用。**判定标准是消费方而非形状**：channels/requirements 迁移中发现 ChannelMessagesResult/RequirementChain/RequirementChainWorkUnit/ChainStatEntry 的下游（store 合并、管道页、徽章）按必填消费，同样要手写 interface；pmo 批次（2/7）新增 Project/Okr/DeliveryStatus/PmoMap/FogItem/PmoDecision（前后端双消费方——web mapUtils/ProjectCard 与 project.service 均按必填消费嵌套 map/fog，z.infer 退化会反向污染赋值点）；请求 body 喂给带必填字段的 service 入参时（channels create agents / send files；pmo createOkr/updateOkr 的 objectives/keyResults、updateProject 整体入参）在路由边界显式收回（map + as / as UpdateProjectInput）。**判别联合同样退化**（批次 3/7 triggers 实测）：z.infer 的 discriminated union 失去 narrowing——TriggerConfigWire 手写 interface，body 喂 store 时 `as TriggerConfig` 收回。
- **defineRoute 配套两坑**（channels 迁移实测）：①handler 里要读「zod 已剥掉的未知键」时（如退役字段守卫 defaultProfileId），schema 须 `.passthrough()` 否则守卫永远看不到；②二进制流 handler（pipe res）必须等 finish 再返回——handler 同步返回时 headersSent 尚未置位，defineRoute 会 res.end() 截断流。
- OpenAPI 文档由本包派生，不手写 yaml。
