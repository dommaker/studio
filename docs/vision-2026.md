# Studio Vision 2026 — 定位与主干设计共识

> 状态：已达成共识（2026-07-18，经决策树逐分支确认）
> 本文档是当前架构的「宪法」。旧文档处置：`docs/DESIGN.md` 等 pipeline 时代文档已归档 `docs/_archive/`；`docs/specs/arch/agent-network.md`（AS-025）保留为实现规格、与本文冲突处以本文为准；`README.md` 已按本文重写。

## 1. 定位：薄编排层

Studio 是一个**多 Agent 群聊控制台**，只做三件事：

1. **任务派发** — 人在频道里提出需求，系统把任务派给 agent CLI 去执行；
2. **状态监控** — 任务/角色/工程的状态可观测，开销可度量；
3. **知识飞轮** — 执行数据沉淀为知识，知识再注入执行，约束随模型能力共同进化。

**Studio 不是什么：**

- 不是 agent CLI 的复刻。@文件、代码级交互、diff 预览等 CLI 能力**不做**——能让 agent 做的事，studio 一律不做。
- 不是 Multica 式的全功能平台。任务看板、工程化协同以「够用」为限，差异化不靠功能堆叠。

**与「直接在 CLI 里输入需求」的区别**（Studio 的存在理由）：

- **持久角色**：agent 是有名字、有职责、有频道成员身份的持久配置（AgentProfile），不是一次性会话；
- **跨会话知识复利**：执行沉淀的知识/约束会注入后续任务，越用越聪明——CLI 单轮交互没有这个；
- **可观测与治理**：多任务、多工程、多 agent 的状态与 token 开销集中可见，需求全链路可追踪（见 §5 PMO）。

## 2. 能力边界：任务级派发

- Studio 产出的是**任务描述 + 上下文注入**（知识、约束、工程信息），交给 agent CLI 在目标工程内执行。
- **工程分配**：WorkUnit 创建时绑定一个已注册工程（workspace = repo 路径 + worktree 隔离）；频道可设默认工程。代码已具备 workspace/worktree 管理能力，直接复用。
- **文件指定**：不由 studio 做。agent 在工程目录内自行定位文件。

## 3. 主干架构：Agent Network（一期）

链路（代码已全部存在，一期目标是修通而非重造）：

```
人 ──频道发消息──▶ @mention 匹配角色 ──▶ 创建 WorkUnit（绑定工程+REQ 编号）
                                            │
                              AgentLoop 认领（observe→claim→step）
                                            │
                          注入知识/约束（≤2K tokens）→ spawn agent CLI
                                            │
              ┌─── COMPLETE ──结果回写频道──┴── NEED_INPUT ──阻塞问题发频道──▶ 人回复 ──▶ 继续执行
              │
              ▼
        执行数据落盘（事件/会话日志）→ 知识飞轮
```

一期要点：

- **双向沟通**：agent 执行中遇到疑问/阻塞，在频道向人提问（做实已有 `NEED_INPUT` 状态机），人回复后继续执行。
- **角色**：角色 = 持久 AgentProfile（provider + 描述 + 频道成员身份）。支持四家 agent CLI：**claude / kimi / codex / opencode**（cli-scanner 配置化）。`.agents/roles/*.yaml` 作为创建 profile 的预设模板。
- **agent→agent 协作**：一期不做，二期再议（需防消息循环、协作预算设计）。
- **成本红线**：知识/约束注入 ≤ 2K tokens/任务；单任务总 token ≤ 直连 CLI 的 1.2 倍；监控页展示「封装开销 vs 直连」对比。

## 4. 知识飞轮

闭环：`执行 → 提取 → 存储 → 注入 → 反馈 → 进化`。每一环代码都存在，但有断点（详见 `plans/2026-07-flywheel-repair.md`）。

已定决策：

- **存储**：单一运行时知识库 `~/.studio/knowledge`（harness FileKnowledgeStore 格式：md + frontmatter + index.json）；仓库内 `.harness/knowledge` 仅放项目级约束知识。**不重建 DB**。
- **检索**：index.json 精确查询 + mcp-local-rag 语义检索，双通道。
- **提取**：任务 COMPLETE 时自动触发一次 LLM 提取（根因/模式/用户偏好）→ 写入知识库，成熟度 = proposal **待审核** → 审核通过才参与注入。模板式提取作兜底。提取开销单独度量，不计入 2K 注入红线。
- **推进顺序**：先通数据（断点 A/B/D + 污染清洗）→ 再度量 → 后进化。

## 5. 特色（差异化价值）

### 5.1 知识复利
数据 → 知识引擎飞轮 → 进化，跨会话沉淀与再注入。对应 Multica 的「团队技能沉淀」，是我们的核心特色。

### 5.2 文档治理
harness 约束体系 + `sync-docs` + **AGENTS.md 生成**（新增能力）+ README 保鲜 + `doc-freshness-check` 入 CI。harness 是自有资产，别家没有。

### 5.3 PMO = 需求编号体系（重定义）
PMO 不是 OKR 异常检测器集合，而是**全链路追踪脊柱**：

- 新增 **Requirement 父实体**：一个需求 = 一组 WorkUnit；
- 编号格式 `REQ-<递增序号>`（如 REQ-0042），频道首次 @mention 派发时自动分配，也可手动创建；
- 需求文档、SDD、产物以编号关联（frontmatter 带 `req` 字段）；UI 按编号串联各环节；
- 现有 project 概念与 Requirement 对齐合并；OKR 页面保留为纯展示；独立 LLM 检测器（okr-anomaly-detector 等）下线。

## 6. 约束进化（第三期）

约束是对模型能力的补充——模型在进化，约束必须同步进化。

- **范围（全范围）**：harness 铁律/guidelines + studio prompt 注入模板 + 角色预设（`.agents/roles/*.yaml`）；
- **机制**：PatternMiner/traces 驱动产生进化提案 → **人在频道审核后生效**（复用双向沟通机制）；
- **排期**：第三期（数据 → 度量 → 进化），先借断点 D 修复把 traces 采集打通。

## 7. UI 调性

以**频道对话流为绝对中心**：左频道列表 / 中对话流（消息卡片即任务状态：执行中/待确认/完成）/ 右侧抽屉（WorkUnit 详情、REQ 全链路、知识命中、token 开销对比）。视觉走「控制台 + 编辑部」质感，具体视觉稿重构阶段另出。死组件簇（StepEditor、PipelineProgress 等）删除，见 `plans/2026-07-cleanup-docs-ui.md`。

## 8. 演进路线

| 期 | 目标 | 对应文档 |
|---|---|---|
| 一期 | 最小闭环修通：4 个 bug + 双向沟通 + 四家 CLI + 工程绑定 | `plans/2026-07-mvp-fix-plan.md` |
| 二期 | REQ 需求编号体系；飞轮通数据（断点 A/B/D + 清洗）；清理废弃代码 | `plans/2026-07-flywheel-repair.md`、`plans/2026-07-cleanup-docs-ui.md` |
| 三期 | 飞轮度量看板；约束进化（提案→频道审核）；UI 重构；文档体系建设 | 同上 |
| 远期 | agent→agent 协作；PMO 聚合视图深化 | 待立项 |

## 9. 决策记录摘要

| # | 决策 | 结论 |
|---|---|---|
| D1 | 定位 | 薄编排层（派发+监控+飞轮） |
| D2 | 与 CLI 边界 | 任务级派发，不复制 CLI 能力；WorkUnit 绑定工程 |
| D3 | agent-network 主干 | 保留现有链路，修 4 个 bug 跑通 |
| D4 | 频道模型 | human→agent + 双向沟通；agent→agent 二期 |
| D5 | 角色/算力 | claude/kimi/codex/opencode；角色=AgentProfile |
| D6 | 成本红线 | 注入 ≤2K tokens；总开销 ≤1.2x 直连 |
| D7 | 飞轮顺序 | 先通数据 → 度量 → 进化 |
| D8 | 特色 | 知识复利 + 文档治理 + PMO（需求编号） |
| D9 | 清理 | 高置信直接删，中置信待确认，两批执行 |
| D10 | 数据组织 | 单库 `~/.studio/knowledge` + 双检索，不重建 DB |
| D11 | 文档体系 | README 重写 + sync-docs 增强（AGENTS.md）+ 旧文档归档 |
| D12 | UI 方向 | 对话流中心 |
