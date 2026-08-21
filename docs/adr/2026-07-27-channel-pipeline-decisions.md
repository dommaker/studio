# 频道全链路改造决策记录（2026-07-27）

> 本文档记录本次"调研 → 逐项确认 → 达成共识"的全部决策。所有决策均已由所有者逐项确认。
> 状态：**已达成共识，待所有者确认执行顺序后方可动工**。

## 0. 背景：调研发现的关键事实

经完整代码与运行数据核查（证据均含文件:行号，见会话调研记录）：

- 频道主路径**不建分支不建 worktree**，agent 直接在共享 workspace 的 master 上改并提交
- **CLI 执行失败被误判为"有进展"**：consecutiveStuck 清零、无限重试、往频道发空消息（agent-loop.ts:547）
- **超时机制整体不存在**：`timeoutAt` 无写入方，workunit-timeout 触发器是死代码
- **评审回传断链**：`metadata.reviewReport` 无生产写入方 → 70 个 WU 中 42 个滞留 in_review
- **告警无出口**：warning/critical 只写事件文件无人消费
- **入口静默丢弃**：纯文本消息不建 WU；mention 未命中也静默 201
- 工程归属链断裂：PMO 项目有 `gitRepo` 字段但与 Requirement/WU 零关联；1499 个频道仅 1 个绑定工程
- 信任链五环缺三环：执行失败检测坏、无验证、无合并、反馈断

## 1. 决策树与已确认决策

### D1 代码隔离与分支策略
每个 WU 一个独立 worktree + `task/<id>` 分支，review 通过后再合并回主分支。冲突集中在合并点处理。

### D2 工程归属（第一性）
**PMO 项目是工程归属锚点**（`gitRepo`/`gitBranch` 字段已存在，接回断链而非新造）：
- Requirement 必须挂到 PMO 项目，继承工程
- WU 从 Requirement 继承工程
- 频道绑定降级为创建 Requirement 时的默认提示
- 以上都得不出 → WU 转 NEED_INPUT 问人，答复写到任务/需求上
- 归属链：`OKR → PMO 项目 → Requirement → WU → 执行 → 进度回写 PMO`

### D3 验证与合并
- 自动验证：test/lint/typecheck，**约定优先**（检测 package.json scripts，存在即跑），频道/工程可覆盖
- reviewer agent 评审通过即自动合并；人保留否决/回滚权
- 合并冲突：系统自动重试，失败把冲突清单发频道转人工
- reviewReport 回传修复（P0），评审输出解析失败转人工而非默认拒绝

### D4 推进顺序
先修 P0 断链，再做架构性改造与优化。

### D5 存量清理
备份后一次性脚本清理：42 个滞留 in_review WU、9+ 个 `daemon/reviewer-*` 分支、`/root/worktrees/reviewer-main` 残留。

### D6 工程发现（两层）
- 排除清单：`STUDIO_PROJECTS_EXCLUDE`（冒号分隔），排除 studio-config 等（**不采用删 .git 方案**——studio-config 三标记全中，删了照样被扫出）
- 显式注册：扫描=候选集，注册（挂 PMO/workspace）=可派活

### D7 角色框架
- 内置 seed 三角色（可覆盖、可禁用）：**pm / dev / reviewer**
- **pm**：需求澄清（常驻澄清 skill，NEED_INPUT 多轮对话）→ 设计 → 拆解 → 固化 Requirement
- **dev**：认领 → worktree 实现 → 验证；`@dev` 明确小活可跳过澄清
- **reviewer**：文档评审（SDD/spec/架构）+ 代码评审，输出结构化 reviewReport；sdd-review 归 reviewer 保持评审独立性
- 角色区分四层模型：skill 全量可见（工具层）+ 认领域分工（入口层）+ 状态机接力（流程层）+ 工件交接（上下文层）

### D8 studio 角色定位
系统后台身份，非业务角色：
- 系统级 LLM 调用身份（SystemExecutor：skill 提取、知识维护 4 类分析），配便宜模型档
- 频道系统提醒署名（agentName 'Studio'）；告警接线后频道内告警统一用此身份
- 不挂 loop、不领任务、不当 reviewer、保留名禁止占用
- `@studio` 不建 WU，转 pm 并提示
- 补 description 说明定位

### D9 skill 装配
| 角色 | 常驻 | 按需 |
|---|---|---|
| pm | 澄清 skill、design-analyst、task-planner | doc-manager、parallel-execution |
| dev | tdd-implement | test-diagnosis、migration-execution、dead-code-removal |
| reviewer | code-review | sdd-review、spec-review、arch-review |
| 系统级 | knowledge-extraction/synthesis/quality、exploration-sediment（trigger 驱动，不动） | |

### D10 skill 匹配（极简方案）
- **全量索引注入**（排除 loop 类）：16 个 skill 索引 ≈800 token，2K 预算装得下，LLM 自选优于 4-gram 预筛
- 超预算才回退现有匹配器截断；**不做打分制改造**（规模问题等规模到了再解决）
- 不新建度量设施；triggers 规范保留作为将来输入

### D11 skill 进化（promote 门禁）
- draft 不进匹配池；发布必须 frontmatter 合规（triggers/description/SKILL.md 实体）
- skill 文档引用的数据源/路径必须真实存在（防 synthesis skill 类腐化）

### D12 需求多轮交互
- NEED_INPUT 多轮对话 + 方案固化进 Requirement
- 澄清做成 skill（可独立优化），pm 常驻
- **修复项**：角色在频道有等待输入的 WU 时，顶层 @该角色 优先复活该 WU 而非新建任务

### D13 工件传递（探索一次原则）
- task-planner 输出契约：task.md 必含"上下文地图"，关键文件片段/签名**直接内联**（消除探索必要性）
- 下游 skill 默认信任地图开工；必须探索时**显式报备**（探索了什么、地图哪条失效）并回写修正地图
- 度量兜底：探索类工具调用占比超阈值记入 skill 质量数据

### D14 traceId
引入 traceId 贯穿 HTTP → WU → agentStep → CLI 执行 → 各日志，补齐 audit 的 requestId。

### D15 通知
- 频道内提醒（保留）+ 企业微信群机器人 webhook（critical）
- **webhook 走环境变量，不落代码**；notifier 抽象接口，Discord 保留为可选渠道
- README.md 补变量配置说明 + 整体按新架构重写

### D16 监控指标体系
实现：落 `studio-events.jsonl` 事件流 + 每日聚合快照 + `/monitoring` 路由展示（每指标带大白话说明），**不新增基础设施**。

七类 + 八项补充：
1. 任务流健康：状态分布/滞留时长、环节转化、失败分桶、空转指标
2. 角色维度：认领/完成率、pm 澄清轮次分布、DELEGATE 方向
3. 工程质量：验证通过率、**上下文地图失效率**、回滚次数
4. Skill 飞轮：采纳率、draft/promote 数据（规模上来前只记录不做决策依据）
5. 知识飞轮：提取/门通过率、事件非空率、引用数（同上）
6. Token/成本：角色/频道/PMO 三维聚合、缓存命中率、每 WU 平均 token
7. 系统健康：现有探测 + 告警触达成功数

补充八项：**入口转化率（消息→WU，防静默丢弃）**、**人工干预次数/完成 WU（北极星）**、**端到端周期（护栏）**、NEED_INPUT 阶段分桶、积压趋势（到达 vs 完成速率）、返工循环分布、越权/安全（申报外修改、MCP 拒绝数）、告警信噪比。

> **北极星：每完成 WU 的人工干预次数**（量化"频道离真正干活的距离"）
> 护栏：端到端周期、自动完成率（无需人工从消息到合并的比例）

### D17 P0 修复清单（六项）
1. 执行失败误判为进展：显式失败分支 + consecutiveStuck 计数 + 频道发帖非空守卫
2. 超时机制接上：WU 写入 timeoutAt + 修触发器比较逻辑 + 超时释放回未指派池（连带治 WU 黑洞）
3. reviewReport 回传：结构化解析写入 + 解析失败转人工
4. 告警出口：warning/critical 接 notifier（频道 + 企业微信）
5. 测试日志与生产隔离 + 归档被污染日志
6. traceId 贯穿（D14）

### D18 知识飞轮裂口（四项）
1. 统一事件写入入口（消灭两条独立流，DailyReflection 读错文件类问题根除）
2. 写入入口校验：空 payload 事件拒收 + warning
3. synthesis skill 文档改 FileStore 数据源 + promote 门禁引用存在性检查（D11）
4. promote 闭环（D11）

### D19 skill 优化纳入本会话执行范围
澄清 skill 新建、各 skill 输入输出契约改造（D13）、synthesis 文档更新，随执行阶段进行。

## 2. 待执行前确认事项

- [ ] 本文档由所有者过目确认
- [ ] 执行顺序与批次划分（建议：P0 六项 → 存量清理 → 归属链/worktree 改造 → 监控指标 → skill 优化 → README）
- [ ] 全程不动手原则解除前，不做任何代码/数据修改
