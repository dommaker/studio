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

## 注意事项

- 只依赖 zod；禁止引入 Node 内置模块依赖（前端 apps/web 也 import 本包）。
- schema 即正本：改字段 = 改这里，前后端编译期同时报错，这是本包存在的意义。
- **z.infer 在本仓退化**：仓 tsconfig strict:false（strictNullChecks off），zod 的 requiredKeys 类型检测全部失效 → z.infer 所有字段变可选。消费方需要必填字段类型的实体（如 WorkUnit）用手写 interface + parity 测试（interface fixture ↔ schema 互验，见 workunit.test.ts）兜漂移；请求/内嵌结果类型 z.infer 全可选无害可继续用。**判定标准是消费方而非形状**：channels/requirements 迁移中发现 ChannelMessagesResult/RequirementChain/RequirementChainWorkUnit/ChainStatEntry 的下游（store 合并、管道页、徽章）按必填消费，同样要手写 interface；pmo 批次（2/7）新增 Project/Okr/DeliveryStatus/PmoMap/FogItem/PmoDecision（前后端双消费方——web mapUtils/ProjectCard 与 project.service 均按必填消费嵌套 map/fog，z.infer 退化会反向污染赋值点）；请求 body 喂给带必填字段的 service 入参时（channels create agents / send files；pmo createOkr/updateOkr 的 objectives/keyResults、updateProject 整体入参）在路由边界显式收回（map + as / as UpdateProjectInput）。**判别联合同样退化**（批次 3/7 triggers 实测）：z.infer 的 discriminated union 失去 narrowing——TriggerConfigWire 手写 interface，body 喂 store 时 `as TriggerConfig` 收回。
- **defineRoute 配套两坑**（channels 迁移实测）：①handler 里要读「zod 已剥掉的未知键」时（如退役字段守卫 defaultProfileId），schema 须 `.passthrough()` 否则守卫永远看不到；②二进制流 handler（pipe res）必须等 finish 再返回——handler 同步返回时 headersSent 尚未置位，defineRoute 会 res.end() 截断流。
- OpenAPI 文档由本包派生，不手写 yaml。
