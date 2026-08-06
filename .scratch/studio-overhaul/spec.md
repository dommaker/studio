# studio-overhaul 重构方案 Spec（工单 07 产出）

> 依据 plan/architecture.md（决策来源）与 research/01-05（证据来源）。Labels: enhancement, ready-for-agent。

## Problem Statement

studio 是私人开发的半成品多智能体协作平台，尚未上线。当前代码库存在：臃肿混乱的业务逻辑（9 个 500-2000 行热点文件、agents/ 目录 40 文件混 6 子域）、大量死代码与废弃功能（59 项确定死导出、12 项候选废弃功能、两个实质整包待删、6 项冗余依赖）、明确的后端性能瓶颈（FileStore 零缓存导致的全量扫描热点）、前端交互断点与繁琐链路（裸 fetch 丢鉴权、alert/整页跳转、失败静默、无 loading、配置丢失）、形同虚设的 i18n 层。维护者与验收者（同一人）需要一套清爽、可导航、无死角的代码库。

## Solution

按"删除 → 修 bug → 性能 → 结构 → 交互 → i18n → 收尾 → 巡检"的顺序执行全量重构：先删除全部经引用链验证的死代码与废弃功能缩小重构面；修复 5 个运行中 bug；给 FileStore 加读穿缓存消除性能总根因；拆分大文件、重组 agents/ 子域、拆分前端大页面；修复全部已知交互断点并补 ui/ 通用件；移除假 seam 的 i18n 层；清理样式冲突、修复 lint、收敛重复实现；最终以架构巡检确认无孤立死代码与无用导入遗留。全程 typecheck + test（4246 用例基线）保持全绿，每处细小优化独立 commit。

## User Stories

1. 作为维护者，我想要删除所有零引用的导出/组件/工具/样式/常量，以便代码库每一寸都有存在理由。
2. 作为维护者，我想要下线 studio-monitor 与 studio-task 两个从未启动的包及其依赖，以便依赖图只反映真实架构。
3. 作为维护者，我想要清理 packages 内各包的大块死实现（mcp-pool 占位、audit-chain、agent-completer、SpecValidator、mock CLI 等），以便子包只承载活代码。
4. 作为维护者，我想要移除无调用方的 API 端点、废弃模块（environments、spec-reviews、outputs、Resolution 影子库）与死文件，以便后端路由表就是真实能力表。
5. 作为维护者，我想要删除前端死组件、review 四件簇、design-lab 原型与死资产，以便页面目录即真实产品目录。
6. 作为维护者，我想要卸载 multer/undici/ioredis/zod 等无引用依赖，以便安装与审计面最小化。
7. 作为用户，我想要 worktree GC 正确扫描实际创建的目录，以便孤儿 worktree 真的被回收。
8. 作为用户，我想要频道分页 limit 生效，以便大频道列表加载正常。
9. 作为维护者，我想要 auth 的 UserData/SessionData 类型单一来源，以便不再有隐藏的类型漂移 bug。
10. 作为用户，我想要点击项目编号跳到存在的页面、错误路径有 404 兜底，以便不撞死路由。
11. 作为用户，我想要通知配置保存后重启不丢，以便配置一次到位。
12. 作为用户，我想要后端接口响应不随数据量线性劣化，以便平台越用越顺。
13. 作为维护者，我想要 FileStore 读写语义在加缓存后完全一致（写后读立刻可见），以便性能优化零行为风险。
14. 作为维护者，我想要 agent-loop/knowledge-service/workunit/okr/metrics 等大文件按已定位的缝拆分，以便每个文件单一关注点。
15. 作为维护者，我想要 agents/ 按子域分目录，以便按业务概念而非文件名找代码。
16. 作为维护者，我想要 route-registry 的注册顺序显式且有断言，以便启动期顺序 bug 不再隐匿。
17. 作为维护者，我想要 PMOPage/KnowledgePage/Settings/ProjectDetailPage/KnowledgeGraphView 拆出弹窗、卡片与纯函数，以便页面文件只编排不实现。
18. 作为维护者，我想要前端配置里的生产地址走配置而非硬编码 IP，以便环境切换安全。
19. 作为用户，我想要所有后端调用统一走 api 层且带鉴权，以便不再出现 401 静默失败。
20. 作为用户，我想要确认操作用统一弹窗、页面跳转不整页刷新，以便交互连贯。
21. 作为用户，我想要操作失败有明确提示、提交中按钮有 loading 不可重复点，以便我知道发生了什么。
22. 作为用户，我想要设置页输入保存有防抖，以便不刷爆接口。
23. 作为维护者，我想要移除 i18n 层统一硬编码中文，以便少一层无人维护的抽象。
24. 作为维护者，我想要样式层无 responsive.css 与 Tailwind 的冲突覆写，以便响应式行为可预期。
25. 作为维护者，我想要 `pnpm lint` 可运行且存量告警基线化，以便 lint 成为真实门控。
26. 作为维护者，我想要 frontmatter 解析与 ID 生成各只有一份实现，以便行为一致。
27. 作为验收者，我想要最终巡检报告证明无孤立死代码与无用导入遗留，以便放心签收。

## Implementation Decisions

- 执行顺序：删除批次（B1-B5）→ bug 修复（C1-C5）→ FileStore 缓存（A1-A3）→ 后端结构（D1-D3）→ 前端结构（E1-E5）→ 交互修复（F1-F4）→ i18n 移除（G）→ 样式/lint/重复收敛（H/I/J）→ 最终巡检。依据 plan/architecture.md 各节。
- FileStore 缓存：接口零变化的实现深化；读穿缓存 + 写/删按路径失效 + list* 并发化；Requirement/Evolution 复制段合并为泛型实现。
- 删除纪律：每项删除前重新 grep 复扫引用链（含字符串路由注册、动态 import），删除后连带清理孤儿测试/样式/常量/类型，typecheck+test 全绿才 commit。
- environments 模块删除前最后复核 scripts/ 与文档引用。
- i18n 移除：t() 调用以其中文 defaultValue 替换；无 defaultValue 的少数 key 从 locale 文件取值内联；分批 codemod，每批 typecheck。
- ui/ 通用件仅补 Modal/ConfirmDialog/Button(loading) 三件，消费方是 F2/F3 的真实改造点，不扩面。
- route-registry：显式注册顺序 + 启动断言，不重写装配机制。
- 硬编码 IP：移入现有配置通道（跟随项目已有 config 模式），不新增配置框架。
- 样式：只修 responsive.css 与 Tailwind 的同名冲突，不动四层混用现状。
- frontmatter/ID 收敛：统一到 studio-shared，调用点逐一切换。

## Testing Decisions

- 好测试的标准：只测外部行为，穿过既有 seam（FileStore 接口、HTTP 路由、store  hooks），不锁实现细节。
- 保护网：既有 4246 用例全绿是每个工单的硬性门槛；typecheck 每次提交前必跑。
- 新增测试仅为 FileStore 缓存行为（写后读一致、失效正确、list 并发等价）——在 file-store 既有测试文件的 seam 上扩展。
- 删除类工单的验证 = 引用链复扫为零 + 全量测试全绿，双条件。
- Prior art：packages/studio-shared 已有 file-store 测试；apps/api 各模块既有 service 测试。

## Out of Scope

- 新基础设施（缓存服务、队列等）；packages 接口级重构；部署/上线（studio-config 仓）；全面样式重构；KnowledgeGraphView 与 PMO OKR 主链路的功能改动；新增产品功能。

## Further Notes

- 工单粒度：单文件/单关注点，1-3 commit/工单；证据细节一律回查 research/01-05，本 spec 不复制。
- 最终巡检工单在全部执行工单闭环后触发，额外专查孤立死代码与无用导入。
