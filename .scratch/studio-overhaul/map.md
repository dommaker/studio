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

## Not yet specified

- 具体重构工单集：待 research + 架构规划 + to-spec 后由 triage 拆出
- 前端交互断点清单：待 web 调研后具象化
- 后端性能瓶颈清单：待 api 调研后具象化
- 候选废弃功能清单：待死代码调研后具象化
- 最终架构巡检（improve-codebase-architecture，重点查孤立死代码与无用导入）：全部执行工单闭环后触发

## Out of scope

- 引入新基础设施（缓存层、消息队列等）
- packages/ 接口级重构（调用方全在仓内可同步改完的除外）
- 上线/部署相关变更（由 studio-config 仓管理）
