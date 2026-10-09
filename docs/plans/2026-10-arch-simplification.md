# 架构精简：死亡面大扫除 + 结构归正 + 防护瘦身

> 状态：Phase 0 已完成（2026-10-08，20 个 commit 落本地 master，65124ad6…bc2743ff）；Phase 1–3 已起票（#681–#696）；P1-1 已完成（#681，2026-10-09：FileStore 11 层继承链改组合——门面持有 WorkUnitStore/MessagesStore/EntityStore/DocsStore 实例逐方法委托，两空壳类删除，CachedFileIo 成读穿缓存唯一实现，seq-entries 并入 EntityStore；queryMessagesPage 五镜像收敛为 iteratePageCandidates 单迭代器 + assembleMessagePage 一次切片，queryMessages 谓词合一 buildQueryFilter；公共面/导出面零变化，studio-shared 690 测试全绿）；P1-2 已完成（#682，2026-10-09：通知域六面合一——notify-channels/outbound-notify 两模块 + utils/notifier + utils/discord-notifier 并入 notifications 单模块（service/routes/channels 三层），utils→modules 反向依赖消除，公共面收敛 index.ts（+notifyAlert/+discordNotifier 系），HTTP 端点零变化；module-cycle 枢纽环簇豁免 20→21 节点（alert-notifier→channels 边入簇），module-barrels 模块计数 37→35）；P1-9 已完成（#689，2026-10-09：builtin-tools 确认死面整删，mcp 三件套复查结论=保留）；P1-7 已完成（#687，2026-10-09：events 三处反向依赖修复——lock-events-bridge 迁 agent-monitor、Skill 建议经 eventBus 倒置入 skills、EXECUTION_STREAM_SSE_TYPE 上移 contract）；P2-1 已完成（#690，2026-10-09：sseEventSchema 接 onmessage 单点（api/sseParser.ts parseSseMessage），14 处 msg.data 裸强转收口为 isSseEvent narrow，畸形负载 console.warn + 丢弃）；P1-4 已完成（#684，2026-10-09：studio-spec 并回 modules/specs、studio-audit/studio-notification 下沉为 audit-logs/notifications 模块内服务 + 进程级单例 getAuditService/getNotificationService，change-history 内存 Map 决策为有意易失工作区不落 FileStore，Prisma 化石注释清除，3 套包接缝与 tsc-gate PKGS 同步消除）；P1-3 已完成（#683，2026-10-09：监控/ops 四胞胎合并为 modules/ops 单模块——src/monitoring + modules/monitoring + agent-monitor + agent-ops 19 源文件 21 测试 git mv 合一，barrel 并集 + getMetrics，HTTP 面零变化；票体「深读业务模块内部解析函数」快照已过期（现状均走对方 barrel）；module-cycle HUB_SCC auth 入簇、新增 ops↔pmo 豁免、模块数 41→33，module-barrels 计数 35→33）
> 前置：docs/plans/2026-10-arch-deepening.md（深化轮，#664–#675 已收官）；目标架构正本 docs/architecture/target-architecture.md

## 工单映射（2026-10-08 起票，全部 ready-for-agent）

| Phase | 工单 | 主题 |
|---|---|---|
| 1 | #681 | FileStore 继承链改组合 + 分页五镜像收敛 |
| 1 | #682 | 通知域合一 |
| 1 | #683 | 监控/ops 四胞胎合并 |
| 1 | #684 | 包下沉（spec 并回 api、audit/notification 下沉） |
| 1 | #685 | contract 解三角（import type 同源 + openapi 搬家 + parity 退役） |
| 1 | #686 | bootstrap 装配表驱动化 |
| 1 | #687 | events 模块反向依赖修复 |
| 1 | #688 | channels/message-routing.ts 拆分 |
| 1 | #689 | 存疑复查（builtin-tools / mcp 三件套） |
| 2 | #690 | SSE 负载运行时校验接线 |
| 2 | #691 | ChannelInput 拆分 |
| 2 | #692 | KnowledgePage 双取数通道合一 |
| 2 | #693 | 前端归位扫尾 + contract meta union 清账 |
| 3 | #694 | 门禁瘦身（tsc-gate 空转/CI 去重/barrel 计数/required_dirs） |
| 3 | #695 | module-cycle 砍粒度 + 鉴权探针派生式 |
| 3 | #696 | profile.channels 兼容链验收删除 + docs/plans 归档 |

## 定位

前两轮把架构"立起来"（契约驱动、模块边界、strict 根基），本轮把它"瘦下来"。
方向：架构清晰优雅、不过度防护、不背历史包袱。
四路勘察（api 模块域 / packages / web / 防护层）结论：最大的不优雅不是缺门，而是死面、兼容残骸、伪拆分、过碎模块、空转防护机制。

## Phase 0：死亡面大扫除（本轮执行）

全部为删除/改名，不改活逻辑。

1. **executions 模块整面**（自标 LEGACY，web 零消费方）：斩 companies/pmo 对 executions.jsonl 的越域深读（okr 项目计数改用 pmo 自身数据）；`POST /events` 挪入 events 模块（路径不变，同机调用方零改动）；删模块 + contract `executions.ts` + route-registry 挂载 + bench 死路径。
2. **agents legacy CRUD 面**：删 legacy routes + AgentRegistry（310 行）+ memoryStore（120 行，假 TTL）+ contract agents legacy schema + route-registry 三档挂载与顺序断言；保留 profile/instance/token 活面。
3. **dingtalk + lark 整删**：两模块只剩占位响应（Meeting 功能早已移除）；route-registry 条目与 PROTOCOL_SURFACE_EXCEPTIONS 同步。
4. **studio-shared `src/cli/` 532 行死面**：零生产消费，子路径导出零 import 方；连带修包 description。
5. **一次性产物 + 空转工具**（约 1800 行含测试）：cleanup-runtime-data、cleanup-stuck-in-review-no-channel、normalize-archive-maturity、bootstrap-incident-ledger、test-health-report 及各自测试；清 roadmap 等引用。
6. **死代码点清扫**：agent-ops `createHealthRoutes`（零调用）；outbound-notify 的 meeting-* 词表/无调用方方法/0 订阅者死发布点；`utils/studio-events.ts` 兼容薄壳（批量改 32 处 import）；deprecated 兼容读一组（均自证存量为零）；workunit.service 兼容门面改直导；delegation-gate 留桩。
7. **前端兼容清账**：workunitStore 双形态兜底、`/project/:id` 重定向、messageMeta 双型、GapCards legacy 别名、LibraryDocPage legacy 渲染分支等。
8. **前端 websocket→sse 正名**（纯 rename）：文件、Provider、hook、消息类型实为 SSE 却叫 WebSocket。

验证：每刀独立 commit；收尾 `pnpm typecheck` + `pnpm build` + 受影响测试绿；模块删除后 `pnpm agents-md:sync` 重建索引。

## Phase 1：后端结构归正（起票）

1. FileStore 组合化：11 层继承链（含 2 空壳类）→ 组合 MessagesStore/WorkUnitStore/EntityStore/DocsStore；收敛 queryMessagesPage 5 份镜像分页实现为单迭代器。
2. 通知域合一：notifications + notify-channels + outbound-notify + utils/notifier + utils/discord-notifier → 单模块，消 utils→modules 反向依赖。
3. 监控/ops 四胞胎合并：src/monitoring + modules/monitoring + agent-monitor + agent-ops → 单 ops 域；消 monitoring 对三业务模块内部解析函数的深读。
4. 包下沉：studio-spec 并回 modules/specs；studio-audit、studio-notification 下沉 api。
5. contract 解三角：允许 `import type` 同源实体形状，消 wire 重声明与 parity 测试层；openapi.ts 转换层搬 apps/api。
6. bootstrap 表驱动化：bridges/services/handlers/warmup 四处同构样板 → 注册表 + 单循环。
7. events 模块反向依赖修复（基础设施 import 业务模块）。
8. channels/message-routing.ts 605 行拆分。
9. 复查存疑：builtin-tools 模块是否纯摆设；mcp tools.ts/tool-registry/tool-store 三件套是否多余门面。

## Phase 2：前端收口（起票）

1. SSE 运行时校验接线：sseEventSchema 接 onmessage 单点，13 处裸强转收口。
2. ChannelInput 697 行拆分：@/# 同构补全状态机合单 hook，上传/merge 预览各拆。
3. KnowledgePage 双取数通道合一。
4. 归位扫尾：159KB 的 src/CONTEXT.md 移 docs/；components/ 纯函数归 utils/；Settings/SidebarNew 正名。

## Phase 3：防护层瘦身（起票）

1. tsc-gate baseline 空转机制删除（baseline 恒 0；build 已含 tsc）。
2. CI 机密扫描三重去重（删 harness 包装步，留 gitleaks-action + pre-commit）。
3. module-cycle 门砍 mutualPairs 细粒度豁免层，留 SCC 冻结。
4. profile.channels 兼容链一次性验收后删（migrate-members + 读回退 + channels-codec 双层解码）。
5. 鉴权探针改姿态表派生式。
6. `.harness/config.yml` required_dirs 自动发现（清单已腐化）。
7. docs/plans 124 个无状态历史文件归档 _archive，活跃计划补 status。
8. barrel 测试去硬编码模块计数。

## 顺序约束

- Phase 0 各刀独立，按 1→8 序执行。
- Phase 1-1（FileStore）放首位；1-5（contract 解三角）影响面最大单独成票。
- Phase 3-4 需先跑一次存量数据验收。
