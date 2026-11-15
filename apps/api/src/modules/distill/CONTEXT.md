# apps/api/src/modules/distill

### 职责

蒸馏主链路：真实进入 WU done 的钩子跑门槛检测（纯确定性计数，零 LLM；#703 previousStatus=done 的补证据事件不重复触发）-> 命中发 `distill_proposal` 卡到 #系统 -> approve 后 system-executor 执行蒸馏 -> 全部派生产物达到 durable 可恢复发布状态 -> 原料 `maturity=archived` -> succeeded 运行记录 + 事件写 `studio-events.jsonl`。

GC 候选清单：蒸馏运行后按周期计龄--reference/context 层连续 3 周期 `lastReferenced` 未更新 -> `gc_proposal` 卡；approve -> archived（可恢复）；reject -> 不再提案。manual 过审享 3 周期豁免；主区 >200 强制。不读墙钟。

产物分类落地：蒸馏 LLM 产出自带类型分类--skill -> skills 库提案（#354 起经 review-proposal 正本 submitSkillProposal，kind='skill'）；preference/execution-knowledge -> 角色记忆草稿。缺/未知类型或落地失败 -> 回落知识库条目。产物都带原料指针。constraint 桶已随 #625 整体退出（#622 裁决：add/override 落点恒 null 是死端、retire 草案零读点，constraint 生命周期归 evolution 飞轮一条链）--constraint 类产物按未知类型回落知识条目。

### 核心导出

- `index.ts` — 模块公共出口 barrel（P2-c 立界：跨模块唯一合法 import 面，实际消费反推生成；深路径 import 由 eslint `local/no-deep-module-import` 拦截）
- `distill-threshold.ts` -- 门槛检测纯函数 + 阈值常量（3/5/7/20）
- `distill-service.ts` -- 编排（subscribe/maybePropose/runGcCheck）+ prompt + 产出解析 + 两 adapter 审批后动作；#716 起 executeDistill/recoverPendingRuns 负责有限重试与启动恢复
- `distill-landings.ts` -- 两通道落地实现：skills 提案 / 角色记忆草稿；返回 `{id,durable}`，恢复按 landingId 或 metadata.productId 认养原产物，重发 card-failed 人审卡；executed/pending 可认养，rejected/failed 不 durable
- `distill-runs.ts` -- runs.jsonl 同 id 追加快照折叠；triggered/running/succeeded/failed/retry-after + attempts/nextAttemptAt/lastError + 完整 products 恢复清单，兼容 legacy executed/failed
- `review-adapters.ts` -- #351 两个人审提案卡 adapter（kind: distill/gc），接线 review-proposal 正本
- `gc-candidates.ts` -- GC 周期计龄纯函数 + 常量（3/200）
- `distill-runtime.ts` -- 懒单例 + 启动订阅与未完成 run 恢复（唯一 import knowledge-singletons）

### 依赖关系

**上游**: `@dommaker/harness`（FileKnowledgeStore）、`@dommaker/studio-shared`（FileStore/eventBus/studioPath）、`knowledge-singletons.ts`（仅 runtime）、`system-executor.ts` + `daily-token-budget.ts`、`channel-message.service.ts` + `studio-events.ts`、`review-proposal`（#351 人审提案卡正本：存取/发卡/approve/reject/status + 通用端点）

**下游**: modules/skills 提案、modules/role-memory 草稿；GC

### 运行时约定

- **P2-e 存储收口**：`firstCompanyId` 的 companies 目录扫描改走 FileStore `readdir`/`readJson` seam（异步化），不再裸 fs 直读数据区。
- 人审闸门：LLM 批处理永远有人确认。pending 期间不重复发卡；触发发卡失败落 `card-failed` 不阻塞后续提案，蒸馏派生产物的 card-failed 则由恢复链按原 proposal 重发卡，不能当作 durable。
- 蒸馏即消费：全部产物 durable 且 >=1 才归档完整 materialIds；空产出不消费。临时模型/存储失败落 retry-after、提案保持 pending，最多 3 次后才 failed；lastConsumedAt 只在 succeeded 后推进。
- 预算守卫：approve 时查 daily-token-budget；耗尽跳过，提案保持 pending。
- approve 非事务：runs.jsonl 在任何产物副作用前保存模型清单，每个 landing 后追加状态；崩溃后续用同一 run/proposal 认养 durable 产物并补齐归档，不再另起提案覆盖。
- topic 来源白名单（#366）：门槛 topic 信号只计 `origin=agent/human` 条目；system（蒸馏产物/规则扫描/历史冷启动灌入）/external/未知来源不凑数不入组——批量同 tag 误触蒸馏的闸门，漏触发由 manual 信号与卡审兜底。「只认创建时自带 tag」未做（需 tag 来源持久化）。
- 来源标定口径（#371 裁决）：`agent` = 会话沉淀，钦定矿石 session-summary 显式声明；机器流一律 `system` 不计入——monitor 告警（聚集=告警多≠可提炼模式）、knowledge-sync 遥测/design-doc 归档、pattern-miner 统计挖掘产物（#366 误触提案卡 pat-* 实证参与者）、resolution 自动落盘。`recordPattern` 缺省 `system`（fail-closed），经该门面的写入路径漏标来源不会误触——绕过门面直调 store 的写入仍须显式标定；存量 44 条经 studio-config/bin/knowledge-relabel-origins-371 一次性重标。
- **契约驱动迁移（2026-10 批次 7/8）结论**：本模块无自有 HTTP 面——提案卡 approve/reject/status 全走 /review-proposals 通用端点（批次 4 已迁），前端 api/distill.ts 亦只消费该面。
