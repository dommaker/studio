# studio-overhaul 架构规划（工单 06 产出）

> 依据 research/01-05 五份报告（细节与证据均在其中，本文件只做决策）。词汇遵循 codebase-design：模块/接口/实现/seam/深度。

## 决策总纲

**执行顺序：B 删除 → C bug 修复 → A 性能 → D 后端结构 → E 前端结构 → F 交互 → G i18n → H/I/J 收尾 → 最终巡检。**

理由：删除先缩小后续每一步的重构面；bug 在结构变动前落地避免纠缠；FileStore 缓存只动实现不动接口，先于结构拆分落地收益最大。

## A. 性能：FileStore 深化（接口不变的纯实现改造）

- **A1**：`studio-shared/file-store.ts` 内部加读穿缓存（read-through），写/删时按路径失效。接口签名零变化——seam 不动，实现加深。`list*` 串行读改并发读。
- **A2**：合并 file-store 中 Requirement 段（917–990）与 Evolution 段（1012–1085）的逐行复制为单一泛型实现（行为不变）。
- **A3**：缓存落地后三大热点残余处置：auth 中间件经缓存自然缓解（不另建 seam）；AgentLoop.observe 去掉 index.json 同轮双读；wu-messenger 消息查询加频道内预过滤，不再跨频道全扫描。

## B. 删除批次（每项先复扫引用链 → 删除 → 连带孤儿清理 → typecheck+test）

- **B1 整包下线**：studio-monitor、studio-task。连带：ioredis 依赖、`/executions/worker/status` 端点、`STUDIO_TASK_QUEUE_ENABLED` 配置与文档、pnpm-workspace/package.json 引用、两包互喂的依赖边。
- **B2 packages 内清理**：capability（company-mcp-pool 574 行 + 市场四方法）、audit（audit-chain 446 行 + mock CLI）、agent（agent-completer 整模块）、spec（SpecValidator 集群 562 行）、skill（matchIntent、definitions 空 stub、死依赖）、shared（死工具/常量/llm-client/FileStore 死方法约 1500 行）、notification（mock CLI）。
- **B3 api 死代码**：channel.routes 178 行死解析器、daemon 孤儿（claim-loop/task-executor 574 行）、environments 模块（删前最后复核 scripts/ 与文档引用）、utils/crypto.ts、discovery-exposure.service.ts、gc-service.ts、死端点（/metrics/routing、/executions/:id/archive、/pmo/okr/metrics、/pmo/okr/data-health、okr-anomaly-detector）、spec-reviews 模块、knowledge Resolution 影子库双实现、outputs 坏链模块、okr.service 5 个仅测试方法 + 恒 false 权限分支、types/index.ts、utils/git.ts、agents/types.ts review 类型残余。
- **B4 web 死代码**：16 个零引用根组件（含 7 个孤儿测试）、review 四件簇（ReviewPanel/MultiStanceReviewPanel/ReviewOpinionCard/StanceBadge）、ToolsStdPage（无导航入口）、design-lab 整目录（有路由无导航、全 mock）、useCapabilities/useCompanyId/useAppStore/superpowersApi、死 css（animations/mission-control）、死静态资源（hero.png、react/vite.svg）。
- **B5 冗余依赖**：multer + @types/multer、undici、zod×4 包、@types/react-router-dom（ioredis 随 B1）。

## C. 运行中 bug 修复（先于结构重构）

- **C1** worktree GC 目录口径不一致（ops.service.ts:528 扫的目录 ≠ agent-loop.ts:1623 创建的目录）——统一到实际创建口径。
- **C2** channel 分页 limit 失效（channel.routes.ts:322）。
- **C3** auth 类型漂移：middleware/auth.ts 与 auth/service.ts 的 UserData/SessionData 统一为单一来源。
- **C4** 前端 `/projects/:id` 死路由（PmoNumberBadge:61）+ App.tsx 补 404 兜底路由。
- **C5** Settings 通知配置重启丢失——修复持久化链路。

## D. 后端结构重构（行为不变）

- **D1** agents/ 40 文件按子域重组：loop / auditor / ops / monitor / knowledge / triage 六个子目录，import 路径同步收编。
- **D2** 大文件拆分（先抽零依赖纯函数区）：agent-loop 尾 430 行纯函数 → agent-loop-utils；knowledge-service Measure 块 350 行；workunit.service 头 300 行类型/mapper；okr.service 指标引擎 550 行；metrics.service 作者已画缝的纯函数区。
- **D3** route-registry 两处顺序敏感依赖：改为显式注册顺序 + 注释固化和启动断言。

## E. 前端结构重构

- **E1** PMOPage：3 个自包含弹窗 + okrMetric 纯函数抽出（削 ~40%）。
- **E2** KnowledgePage：底部 6 个纯展示卡片抽出。
- **E3** Settings：8 个 section 组件化。
- **E4** ProjectDetailPage：IDE 指南弹窗/知识网格/进展卡抽出；消除硬编码生产 IP（:58,64，改走配置）。
- **E5** KnowledgeGraphView：布局算法/diff 计算抽为纯函数模块。

## F. 前端交互修复（允许改行为，删繁就简）

- **F1** 5 处裸 fetch 收编进 api/ adapter 层（补鉴权头）：AuditLogsPage、ToolsStdPage（若 B4 未删）、CreateToolStdModal、DeleteButton、IronLawsSection。
- **F2** alert/window.confirm 3 处 → 统一确认弹窗组件；window.location.href 整页跳转 4 处 → SPA 路由导航。
- **F3** 失败静默补错误提示（PMOPage loadData、KnowledgePage 新建）；表单加 loading 防重复提交（ChannelListPage 等）；Settings 公司名逐击键保存加防抖。
- **F4** ui/ 设计系统补通用 Modal/ConfirmDialog/Button(loading 态)——有 F2/F3 真实消费方，seam 成立。

## G. i18n 决断：移除

locale 仅 19 key vs 171 处 t() 调用、87 个文件硬编码中文——i18n 是"单 adapter 的假 seam"。移除 react-i18next：171 处 t() 以其中文 defaultValue/约定文案替换，删 locale 文件与初始化。分批 codemod + typecheck + 抽查。

## H. 样式收尾

仅消除 responsive.css 在媒体查询中覆写 Tailwind 同名工具类的冲突项；死 css 随 B4 删。不做全面样式统一（风险大、验收难，出范围）。

## I. lint 修复

修 eslint 配置使 `pnpm lint` 可跑（apps/web flat config、studio-capability 缺依赖），存量告警基线化，转为可用门控。低优先级。

## J. 重复实现收敛（顺手批次）

frontmatter 解析 3 份 → 收敛到 studio-shared 一份；ID 生成 6 处 → 统一工具。低优先级，不阻塞主线。

## 出范围（与 map.md Out of scope 一致）

不引入新基础设施；packages 不做接口级重构（B2 均为仓内零消费或内部实现）；不动部署/上线；不做全面样式重构；KnowledgeGraphView 主链路、PMO OKR 主链路确认存活，只清理其死子端点。

## 测试与门控策略

- 每个执行工单：改动前复扫引用链（删除类）→ 改动 → `pnpm typecheck` → 该域相关测试 → commit；工单收尾跑全量 `pnpm test`。
- 既有 4246 用例是外部行为保护网；删除类工单以"全绿且引用链复核为零"双重验证。
- FileStore 缓存在 FileStore 既有接口 seam 处补测试（读写一致性、失效正确性）。
