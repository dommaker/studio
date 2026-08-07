# Wayfinder Map — studio-overhaul

## Destination

studio（/root/projects/studio）全套代码优化重构完成：6 项优化清单闭环（臃肿业务逻辑重构、超大文件拆分、死代码/冗余依赖/废弃功能清除、后端性能瓶颈消除、前端 UI 交互流程重构、交互断点根除），typecheck + test 全绿，最终架构巡检通过，产出可供用户次日验收的完整 commit 序列。

## Notes

- 领域：Agent Studio 多智能体协作平台；pnpm monorepo（apps/api 247 源文件、apps/web 131、packages/* 9 个子包）；FileStore 无 DB；中文 Conventional Commits。
- 技能：research、codebase-design、to-spec、triage、improve-codebase-architecture、prototype、diagnosing-bugs。
- 常设授权（2026-08-07 用户一次性 grilling 答复"同意"，全部按推荐）：
  1. 完成定义 = 6 项清单闭环 + 巡检通过 + 门控全绿 + commit 序列可验收
  2. 门控：每次提交前 `pnpm typecheck`；每个工单结束 `pnpm test`；lint 不新增告警；e2e / spec-gate / architect:check 不强制
  3. 后端为行为不变的纯重构；前端 UI/交互允许改行为（简化链路、消除断点）
  4. 废弃判定：无入口可达 / 无调用方 / 标记 deprecated / 默认关闭从未启用；先列候选废弃清单、完整扫描引用链后批量移除，连带清理孤立死代码
  5. packages/ 只清死代码与明显冗余，不做接口级重构（调用方全在仓内可同步改完的除外）
  6. 性能限定消除明显瓶颈（N+1 文件读写、同步阻塞、重复计算、过密轮询），不引入新基础设施
  7. 直接在当前分支提交；AGENTS.md 未提交改动检查后并入首个提交
  8. 工单拆到单文件/单关注点，1-3 commit/工单
  9. 调研/扫描/巡检一律委派 subagent，主会话只持工单状态与决策
  10. 04:15 cron（id 9bbbe7ad）仅作断点续跑保险，全部闭环后 CronDelete
- 跟踪器偏差：仓 AGENTS.md 指定 GitHub Issues，但仓为 **public**，在公网发布内部重构细节不可逆；本次行动工单使用 local-markdown 跟踪器（`.scratch/studio-overhaul/`），验收后再决定是否同步。
- 执行覆盖：本 map 携带执行（用户硬性规则覆盖 wayfinder 默认 plan-only 与单会话单工单限制）：research 完成后不间断串行 codebase-design → to-spec → triage → 逐工单执行，每处细小优化独立 commit，全程禁止向用户提问、禁止暂停等待指令。

## Decisions so far

- [01 — API 后端源码调研](issues/01-research-api-backend.md) — FileStore 零缓存是性能总根因；9 热点文件拆分缝定位；agents/ 40 文件 6 子域待重组；3 个运行中 bug 发现
- [02 — Web 前端源码调研](issues/02-research-web-frontend.md) — 6 大文件拆分缝；6 类交互卡点清单；i18n 形同虚设需二选一；~20 死文件 2500+ 行
- [03 — 死代码/冗余依赖/候选废弃功能调研](issues/03-research-dead-code.md) — 59 项确定死导出、12 项候选废弃功能、6 项冗余依赖，全部附引用链证据与连带孤儿清单
- [04 — packages/ 子包调研](issues/04-research-packages.md) — 9 包健康档案；capability 67%/audit 63% 死代码；monitor/task 实质整包待删；file-store 两段逐行复制
- [05 — 门控基线建立](issues/05-gate-baseline.md) — typecheck 全绿、test 全绿（4246 用例）、lint 损坏不可跑；基线提交 46a2cf8f
- [06 — 模块架构规划](issues/06-architecture-plan.md) — 执行顺序 B删除→C修bug→A性能→D后端结构→E前端结构→F交互→G i18n→H/I/J→巡检；FileStore 缓存为主杠杆；i18n 判定假 seam 移除
- [07 — 完整重构方案](issues/07-refactor-spec.md) — spec.md：27 条用户故事 + 实现/测试决策 + 出范围清单，ready-for-agent
- [08 — triage 拆解执行工单](issues/08-triage-execution.md) — 执行工单 09-43 共 35 张全部拆出并标注依赖边，进入串行执行
- 删除批次 09-23+44 全部解决（12 张）：累计删 ~9000 行——两整包（monitor/task）、packages 七刀、api 三刀（含 OKR B8 引擎级联删除 1156→334 行）、web 两刀（含 design-lab/ToolsStdPage/review 簇）、依赖 8 项；test 4246→3933 全绿；期间纠正证据误判 3 处（PMOCard 活链、mc-*/u-* 活样式、js-yaml 类型）
- bug 批次 24-25 解决：C1-C5 全修复（GC 口径、分页 limit、auth 类型单一来源、死路由+404、通知配置落盘持久化），各附新测试
- 性能批次 26-27 解决：FileStore 读穿缓存（mtime 校验 + structuredClone 防污染 + list 并发化 + 9 条新测）+ Requirement/Evolution 复制段泛型合并 + observe 双读消除 + wu-messenger 频道内预过滤
- 后端结构批次 28-32 解决：agent-loop 2024→1542、knowledge-service 1720→1143、workunit 1179→889、metrics 666→113；agents/ 46 文件按 6 子域重组；route-registry 顺序断言 fail-fast
- 前端结构批次 33-35 解决：PMOPage 929→403、KnowledgePage 519→368、KnowledgeGraphView 488→283、Settings 482→244、ProjectDetailPage 558→381；硬编码生产 IP 改走 vite env
- 交互批次 36-38 解决：ui/ Button+ConfirmDialog 通用件、confirm/alert/整页跳转全替换、裸 fetch 收编 api/auditLogs、失败提示/loading 防重/公司名防抖
- 收尾批次 39-42 解决：i18n 整层移除（54 处 t() 内联中文）、responsive.css 8 处 Tailwind 冲突消除、frontmatter/ID 收敛、eslint 9 flat 迁移 lint 可跑（0 错误 275 告警基线）
- [43 — 最终架构巡检](issues/43-final-inspection.md) — **判定：达到交付状态**；三门控全绿（test 3973 双连绿）；专扫遗留 7 项全修；建议后续工单 5 项（档案/基线性质不阻塞）

## Not yet specified

- （全部已毕业为工单 09-43）

## Out of scope

- 引入新基础设施（缓存层、消息队列等）
- packages/ 接口级重构（调用方全在仓内可同步改完的除外）
- 上线/部署相关变更（由 studio-config 仓管理）
