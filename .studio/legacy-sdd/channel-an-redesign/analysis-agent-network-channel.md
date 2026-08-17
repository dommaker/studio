# Channel × Agent Network 第一性分析

> 分析时间：2026-07-08
> 来源：频道系统重构（channel-an-redesign）完成后的深度讨论
> 状态：draft — 待继续深入

---

## 一、背景

频道系统重构（12 AC）已完成并部署：
- Phase 1：删除旧模式（conversation/analyst 链）+ 消息路由重写
- Phase 2：前端适配（@mention autocomplete API + thread 回复 UI）

完成后的核心问题：**Channel 在 Agent Network 中的完整流程是什么？**

---

## 二、当前实现状态

### 已实现

```
Channel 消息路由（message-routing.ts）：
  @mention → WorkUnit 创建（assigneeId=null，任意 Agent claim）
  replyToId → 继承 workUnitId（thread 反馈通道）
  plain → 纯存储（不创建 WorkUnit）

AgentLoop（agent-loop.ts）：
  observe() → 查 unassigned WorkUnit（按 channel + type 过滤）
  resolveTarget() → 优先级：人类回复 > 自己的 active WU > 最早 unassigned > null
  claim() → 乐观锁，先到先得
  agentStep() → Claude Code CLI 执行
  recordResult() → 结果回写 Channel
```

### 数据现状

```
AgentProfile: 1 个（test-executor），channels="[]"（空=看所有 Channel）
Channel: 3 个（#研发 #决策 #系统）
RuntimeInstance: 由 API 启动时为每个 active AgentProfile 创建
```

---

## 三、Raft 参考模型

### 工程团队配置

```
1 个 Channel (#build)
├── @Pat (PM)       — 需求拆解，验收标准
├── @Hank (Engineer) — 实现合约，不变量，失败模式
└── @Rin (Reviewer)  — 审查门禁，可验证清单
```

### Raft 核心模式

| 模式 | Raft 做法 | Studio 当前 | 差距 |
|---|---|---|---|
| @mention 直接路由 | @Pat → Pat 收到，其他人不收到 | 创建 WorkUnit，任意 Agent claim | 无 assigneeId 绑定 |
| Convert to Task | 任何消息可右键「转为任务」 | 普通消息永远只是消息 | 无涌现机制 |
| Thread = 工作作用域 | Agent 在 Task Thread 里发进度 | Agent 结果回写主 Channel（无 replyToId） | 主 Channel 信噪比低 |
| Channel 历史 | Agent 加入时读最近 200 条 | Agent 不看 Channel 历史 | 无上下文恢复 |
| Agent 加入 Channel | 主动 join，成员关系即路由 | channels=[] 全看，无隔离 | 未启用 |
| Agent 持久身份 | 有名字+角色+记忆 | AgentProfile + 临时 RuntimeInstance | 无跨 session 记忆 |

### Raft 关键设计原则

> "Agents follow the channels they're in, so the room naturally routes the work."

- Channel 成员关系 = 路由表（不需要中央调度器）
- @mention = 寻址信号（指定对话对象）
- Thread = 任务作用域（保持主 Channel 干净）
- Convert to task = 讨论中涌现工作

---

## 四、六个模式的第一性分析

### 模式一：@mention → assigneeId 绑定

**本质**：@mention 是寻址信号，不是任务创建按钮。

```
@Pat 拆需求     → 寻址：Pat     → 只有 Pat 应该响应
随便说句话       → 广播：所有人   → 谁觉得相关谁响应
Thread 回复      → 寻址：原 Agent → 反馈给正在工作的人
```

**当前问题**：@mention 匹配到 Agent 但 `assigneeId=null`，人的意图（找谁）被丢弃。

**结论**：@mention 匹配到 Agent → `WorkUnit.assigneeId = agent.id`。Agent 不在线 → 超时释放 → 其他 Agent 可 claim。

**改动量**：message-routing.ts 一处。

### 模式二：Convert to Task

**本质**：不是所有工作都从 @mention 开始。很多工作从讨论中涌现。

**WorkUnit 产生的三种时机**：

| 时机 | 谁触发 | Studio 当前 |
|---|---|---|
| 显式指令 | 人类 @mention | ✅ 已实现 |
| 涌现识别 | 人类手动「转为任务」或 Agent 识别 | ❌ 缺失 |
| 系统调度 | Scheduler trigger | ✅ 已实现 |

**两层方案**：

```
层 1（低成本）：API 端点 — 任何消息可 convert to WorkUnit
  POST /channels/:id/messages/:msgId/convert-to-workunit
  前端：消息 hover 菜单加「转为任务」按钮

层 2（高成本）：Agent 感知涌现
  AgentLoop.observe() 扫描近期无 WorkUnit 的消息
  LLM 判断是否包含可执行任务 → 是 → 创建 WorkUnit 并 claim
```

### 模式三：Thread = 工作作用域

**本质**：多任务并行时隔离上下文，保持主 Channel 高信噪比。

**当前问题**：Agent 的 `postToDiscussionSpace` 直接写 ChannelMessage，不带 replyToId。进度消息散落在主 Channel 时间线。

**应该做什么**：Agent 执行过程中的所有消息都带 replyToId（指向触发消息或 Thread 锚点）→ 在 Thread 内渲染。主 Channel 只显示 Task 创建 + 完成通知。

### 模式四：Channel 历史 — Agent 上下文恢复

**本质**：Agent 不是永远在线的，醒来时需要知道发生了什么。

**Agent 上下文的两个来源**：

| 来源 | 内容 | 当前 |
|---|---|---|
| WorkUnit 维度 | 自己负责的 WorkUnit 的进度、回复 | ✅ 已有 |
| Channel 维度 | Channel 里最近发生的所有讨论 | ❌ 缺失 |

**应该做什么**：AgentLoop.observe() 增加一步 — 查自己 channels 中近期消息，注入 agentStep prompt 作为上下文。

### 模式五：Agent 加入 Channel — 路由表

**本质**：Channel 成员关系解决注意力范围问题。不是所有 Agent 都需要关心所有 Channel 的工作。

**当前**：`channels=[]` 兜底看全部。无 join/leave 流程。

**应该做什么**：
1. Agent 创建时指定 channels（字段已有，未使用）
2. 或提供 join/leave API
3. AgentLoop.observe() 严格按 channels 过滤（移除空数组兜底）
4. 前端 @mention autocomplete 只显示当前 Channel 内的 Agent

### 模式六：Agent 持久记忆

**本质**：Agent 需要跨 session 的经验积累，不能每次从零开始。

**三种记忆类型**：

| 类型 | 人类类比 | Agent 对应 | Studio 当前 |
|---|---|---|---|
| 情景记忆 | 「上周二我修了个 bug」 | 过去的任务执行记录 | ❌ 缺失 |
| 语义记忆 | 「这个项目用 SQLite」 | 从经验中提炼的偏好/事实 | 仅全局知识 |
| 程序记忆 | 「我知道怎么 review」 | 积累的操作模式 | ❌ 缺失 |

---

## 五、DATA 驱动的知识架构（修正版）

### 核心洞察

不需要独立的「Agent 记忆系统」。知识引擎飞轮已经是完整基建。Agent 的「记忆」就是知识引擎在特定工作场景下产出的知识。

### 否定方向

```
❌ per-agent 记忆目录（~/.studio/memory/{agentId}/）
  → 知识耦合身份，身份变了知识断
  → 不同人做同样的事，知识不共享

❌ agentId 标签
  → agentId 是身份不是场景
  → 知识应该跟场景走，不跟人走

❌ 独立提取管线（个人 + 全局两条）
  → 同一套飞轮，不需要两条管线

❌ 晋升机制（个人记忆 → 全局知识）
  → 不需要，知识天然按场景组织
```

### DATA 是一切的基础

```
DATA（原始数据）= 飞轮的输入：
  ├── session 日志（Agent 做了什么）
  ├── skill 使用记录（用了什么 skill，产出什么）
  ├── 监控日志（token 消耗、执行时间、成功/失败）
  ├── 对话记录（Thread 消息、人和 Agent 交互）
  ├── 代码变更（改了哪些文件）
  └── WorkUnit 结果（成功/失败/部分完成）

这些全是 DATA，平级的。
skill 只是其中一种数据，不是维度。
```

### 上下文标签（不是 agentId）

```
知识关联的是工作场景，不是人：

Pat 做完需求 A 的设计，学到：
  ❌ 标签 agentId=Pat（耦合身份）
  ✅ 标签 project=projectA, workType=design（耦合场景）

下次任何人做 design 在 projectA → 都应该知道这条知识
```

### 存储格式：JSONL + md

```
JSONL（日志型，追加写，机器消费为主）：
  ├── Channel 消息 → data/channels/rnd.jsonl
  ├── Session 日志 → data/sessions/2026-07-09.jsonl
  ├── Skill 执行记录 → data/skills/2026-07-09.jsonl
  └── 监控日志 → data/metrics/2026-07-09.jsonl

md（内容型，人/LLM 直接读）：
  ├── 知识条目 → knowledge/*.md（已有）
  ├── WorkUnit → workunits/*.md
  └── Agent 配置 → agents/*.md
```

### 目录结构

```
.studio/
  ├── data/                          # JSONL（日志型数据）
  │   ├── channels/
  │   │   └── rnd.jsonl              # Channel 消息流
  │   ├── sessions/
  │   │   └── 2026-07-09.jsonl       # session 日志
  │   ├── skills/
  │   │   └── 2026-07-09.jsonl       # skill 执行记录
  │   └── metrics/
  │       └── 2026-07-09.jsonl       # 监控指标
  │
  ├── knowledge/                     # md（知识，已有）
  │   └── entry-001.md
  │
  ├── workunits/                     # md
  │   └── wu-001.md
  │
  └── agents/                        # md（配置）
      └── pat.md
```

### JSONL 格式示例

```jsonl
// channels/rnd.jsonl
{"ts":"2026-07-09T10:00:00Z","author":"human","content":"@Pat 需求A...","project":"projectA","thread":"wu-001"}
{"ts":"2026-07-09T10:05:00Z","author":"Pat","content":"分析完成...","project":"projectA","thread":"wu-001","skill":"design-analyst"}

// skills/2026-07-09.jsonl
{"ts":"2026-07-09T10:03:00Z","skill":"design-analyst","project":"projectA","workUnit":"wu-001","duration":180,"result":"success"}
```

### 飞轮如何覆盖「Agent 记忆」

```
数据产生：
  Agent 工作 → 产生 DATA（session + skill + conversation...）
  → DATA 自然带有上下文标签（project + workType）

提取：
  PatternMiner 分析 DATA → 产出知识条目
  → 知识条目带 context 标签（project + workType）
  → 不需要 agentId

存储：
  ~/.studio/knowledge/（统一存储，已有基建）

消费：
  Agent spawn → 知道当前 WorkUnit 的 project + workType
  → 查知识存储（按 context 过滤）
  → 注入 prompt

进化：
  同一类工作积累足够多经验 → 合成为通用模式
  → 跨项目通用 → 去掉 project 标签，只留 workType
```

### 持久化机制

```
WorkUnit 内部连贯 → Claude Code session 机制（已有）
跨 WorkUnit 经验 → 知识引擎飞轮（已有基建 + context 标签）

不需要新建记忆系统
飞轮还是那个飞轮
只是输入更丰富（带标签的 DATA），输出更精准（按场景过滤）
```

### 知识存储：个人 + 项目双层

```
~/.studio/knowledge/              # 个人知识（不共享）
  → 跨项目的通用经验
  → 个人偏好、习惯
  → 不进 git

projectA/.studio/knowledge/       # 项目知识（git 共享）
  → 关于 projectA 的知识
  → 项目特定的模式/教训/决策
  → 进 git，团队共享
```

**判断标准**：换个人做这个项目，需要看到吗？
- 需要 → 项目目录（git 共享）
- 不需要 → ~/.studio/（个人本地）

**知识沉淀逻辑**：
```
Agent 在 projectA 工作 → 产出知识
  → 引擎提取时判断：带 project 标签？
  → 是 → 写入 projectA/.studio/knowledge/（git 追踪）
  → 否（通用的）→ 写入 ~/.studio/knowledge/（个人）
```

**消费方式**：MCP query_documents 按需查询，不是注入
```
Agent 工作中需要知识 → 调 query_documents
  → 查 projectA/.studio/knowledge/ + ~/.studio/knowledge/
  → 只返回相关的几条
  → 零噪音，零 token 浪费
```

### 可行性验证

```
现有基建：
  query_documents → mcp-local-rag（LanceDB 向量搜索）
  知识写入 → KnowledgeBus → FileKnowledgeStore
  向量同步 → scheduleVectorDbSync → mcp-local-rag ingest
  知识审计 → harness knowledge audit（支持 --dir）

关键发现：LanceDB 是单一向量表
  → 所有 ingest 的文件都在同一向量空间
  → 查询侧零改动（天然跨文件搜索）

需要的改动：
  🔧 scheduleVectorDbSync：多目录 ingest 到同一 DB
  🔧 KnowledgeBus 写入：按 project 标签决定写入目录
  🔧 knowledge audit：扫描多目录（已有 --dir，扩展）

不需要改：
  ❌ mcp-local-rag 本身
  ❌ query_documents 接口
  ❌ LanceDB 查询逻辑
```

---

## 六、Harness vs Studio 分工

### 判断标准

- 不需要 LLM → harness 基建
- 需要 LLM → studio 业务

### 具体划分

**Harness（纯代码，零 LLM）**：

| 组件 | 内容 |
|---|---|
| DATA 层 | JSONL 统一存储（channels/sessions/skills/metrics） |
| DATA 标签规范 | 每条数据带 context 标签（project/workType） |
| Skill 执行记录 | Skill 完成时自动写 JSONL 记录 |
| 知识检索扩展 | MCP query_documents 加 context 过滤（按 frontmatter/标签） |
| 项目发现 | 扫描本地目录，检测项目（CLAUDE.md/package.json/.git） |

**Studio（需要 LLM）**：

| 组件 | 内容 |
|---|---|
| agentStep 记忆注入 | 构建 prompt 时查询相关记忆，注入 top-N |
| 经验蒸馏 | LLM 分析 Agent 历史，提取模式/偏好/教训 |
| Channel 上下文读取 | observe() 查近期消息，注入 prompt |
| Convert to Task | API + 前端（不依赖 LLM，但属于业务逻辑） |
| @mention 绑定 | message-routing.ts 修改 |

### 执行顺序

```
Phase 1: 本地化改造（基础）
  L1: 项目发现（扫描本地目录注册 Project）  ← 前置依赖
  L2: WorkUnit 关联 Project
  L3: Agent 执行 cwd = project.path（直接本地 spawn）

Phase 2: Channel 路由完善
  S1: @mention → assigneeId 绑定
  S2: Convert to Task API（LLM 预填 + 人选项目，依赖 L1）
  S3: Thread-per-WorkUnit + Agent 消息写入 Thread

Phase 3: DATA 层建设
  D1: JSONL 统一存储（channels/sessions/skills/metrics）
  D2: DATA 标签规范（project + workType）
  D3: Skill 执行时自动写记录

Phase 4: 知识引擎扩展
  K1: PatternMiner 提取时感知 context 标签
  K2: MCP query_documents 加 context 过滤
  K3: Agent spawn 时按当前场景注入知识

Phase 5: 执行隔离 + 数据迁移
  I1: Agent 执行用 git worktree 隔离
  I2: WorkUnit md 文件化
  I3: 现有 SQLite 数据迁移到 JSONL/md
```

---

## 七、缺口清单

> 注：#4 竞争无能力过滤 已被第八节设计决策解决（@mention 绑定 = 无竞争）。
> Agent 能力模型（capability）不再需要 — LLM 是能力引擎。

| # | 缺口 | 归属 | 优先级 | 改动量 |
|---|---|---|---|---|
| 1 | @mention 不绑定 assigneeId | Studio S1 | **P0** | 1 行 |
| 2 | listAgents 不过滤 RuntimeInstance 状态 | Studio | P2 | 中 |
| 3 | ~~Agent.channels 为空时看全部~~ | — | — | **已解决：Channel 管成员列表，Agent 不需要 channels 字段** |
| ~~4~~ | ~~竞争无能力过滤~~ | — | — | **已解决：@mention 绑定** |
| 5 | 无 @mention 消息不涌现 WorkUnit | Studio S2 | P2 | ~50 行 |
| 6 | Agent 进度不在 Thread 内 | Studio S3 | P2 | ~20 行 |
| 7 | Agent 不读 Channel 历史 | Studio S6 | P3 | ~40 行 |
| 8 | ~~Per-agent 记忆存储~~ | — | — | **已取消：不需要独立记忆系统** |
| 9 | ~~Per-agent 记忆检索~~ | — | — | **已取消：知识引擎按 context 过滤** |
| 10 | ~~agentStep 记忆注入~~ | Studio | — | **重设计：按场景标签注入知识（Phase 4 K3）** |
| 11 | ~~经验蒸馏（LLM）~~ | — | — | **已有：知识引擎 PatternMiner 覆盖** |
| 12 | ~~记忆晋升~~ | — | — | **已取消：不需要晋升机制** |
| 13 | studio-daemon（引擎发现+进程管理） | Harness H1 | — | **已取消：Studio 本身是本地服务，不需要 daemon** |
| 14 | Workspace 注册协议（daemon↔server） | Harness H1 | — | **已取消：同上** |
| 15 | Agent 执行迁移到 daemon（server 不再 spawn CLI） | Harness | — | **已取消：本地服务直接 spawn** |
| 16 | 项目发现（扫描本地目录注册 Project） | Studio | P1 | 中 |
| 17 | Channel 绑定 Project | Studio | P1 | 中 |
| 18 | Agent 执行用 git worktree 隔离 | Studio | P2 | 中 |
| 19 | 数据存储从 SQLite 迁移到 JSONL/md | Studio | P2 | 大 |
| 20 | Thread-per-WorkUnit（WorkUnit 创建时自动创建 Thread） | Studio | P1 | 中 |
| 21 | Agent 消息写入 Thread（postToDiscussionSpace 带 replyToId） | Studio | P1 | 中 |
| 22 | DATA 层统一存储（JSONL：channels/sessions/skills/metrics） | Harness | P1 | 中 |
| 23 | DATA 标签规范（每条数据带 project + workType） | Harness | P1 | 小 |
| 24 | Skill 执行自动写记录（JSONL） | Harness | P1 | 小 |
| 25 | MCP query_documents 加 context 过滤 | Harness | P2 | 中 |
| 26 | Agent 按需查询知识（非注入） | Studio | P2 | 小 |
| 27 | 知识双层存储（个人 + 项目目录） | Harness | P2 | 小 |
| 28 | scheduleVectorDbSync 多目录 ingest | Harness | P2 | 小 |
| 29 | KnowledgeBus 按 project 标签写对应目录 | Studio | P2 | 小 |

---

## 八、设计决策收敛（2026-07-08 讨论）

### AgentProfile 最小设计

**决策**：AgentProfile = name + description + channels + status + memory。
**不添加** role、capabilities 等结构化字段。

**理由**：
- Agent 本质是 LLM 驱动的。LLM 就是能力引擎，不需要结构化能力描述
- description 面向人类选择（「这个 Agent 做什么」），不是给机器过滤的
- role/capabilities 是 Pipeline 思维的残留（预定义执行路径）
- 多角色 Channel 里靠 @mention 路由，不靠 capability 匹配

### @mention = 路由机制

**核心洞察**：多角色 Channel（如 Raft 的 Pat/Hank/Rin）需要一种机制让人指定「找谁做事」。@mention 就是这种机制。

```
@Pat 拆需求     → 只 Pat 响应（assigneeId=Pat.id）
@Hank 实现      → 只 Hank 响应（assigneeId=Hank.id）
随便说句话       → 广播，谁觉得相关谁 claim（assigneeId=null）
```

**之前错误结论**：「@mention 硬绑定 = Pipeline 耦合」。
**纠正**：Pipeline 耦合是指硬编码执行流程（A→B→C 固定链路）。@mention 是寻址信号（选择对话对象），完全不同。群聊里 @某人 = 找某人说话，这是基本社交协议。

**结论**：@mention 匹配到 Agent → `WorkUnit.assigneeId = agent.id`。这不是耦合，是正确路由。

### 多角色 Channel 的竞争问题

**问题**：「所有 WorkUnit 都可 claim，LLM 自己判断能不能做」在多角色 Channel 失效。

```
Raft 模式：#build 有 Pat(PM) + Hank(Engineer) + Rin(Reviewer)
一条无 @mention 消息 → 3 个 Agent 都看到 → 都可能 claim
→ Pat 拆了需求 → Hank 也开始拆（不是他的活）→ 混乱
```

**解法**：
1. **有 @mention** → assigneeId 绑定，只有被 @ 的 Agent claim
2. **无 @mention** → 两种处理：
   - 纯讨论（不创建 WorkUnit）— 当前已实现
   - Convert to Task（人类手动转为 WorkUnit）— 待实现
3. **Agent 自主涌现**（层 2）— 长期，需要 LLM 判断能力匹配

**人类是路由器**：在多角色场景，人类通过 @mention 选择正确的 Agent。系统不需要替人做这个决策。

### 当前 @mention 实现链路

```
前端：ChannelInput → channelApi.listAgents() → GET /agent-profiles?status=active
      ↓ 显示 @mention autocomplete 下拉
      ↓ 用户选择 → 插入 @AgentName 到消息内容

后端：message-routing.ts → detectMention() 解析 @AgentName
      ↓ 匹配 AgentProfile（by name）
      ↓ 创建 WorkUnit（assigneeId=null ← 这里要改为 agent.id）
```

**当前数据**：1 个 AgentProfile（test-executor），无 seeding，无 role 字段。
前端 autocomplete 已对接 API，改动只在后端路由层。

### 8 个缺口 → 方案映射

| # | 缺口 | 方案 | 状态 |
|---|---|---|---|
| 1 | @mention 不绑定 assigneeId | message-routing.ts 改 1 行 | 待实现 |
| 2 | listAgents 不过滤在线状态 | agent-profile.service JOIN RuntimeInstance | 待设计 |
| 3 | Agent.channels 空=看全部 | 创建时指定 channels / join API | 需进一步设计 |
| 4 | 竞争无过滤 | @mention 绑定后此问题消失（有 @ 无竞争） | 自然解决 |
| 5 | 无涌现机制 | Convert to Task API + 前端按钮 | 待实现 |
| 6 | Agent 进度不在 Thread | postToDiscussionSpace 带 replyToId | 待实现 |
| 7 | Agent 不读 Channel 历史 | observe() 查近期消息注入 prompt | 待实现 |
| 8 | 无持久记忆 | 三层记忆架构（见第五节） | 长期 |

### 算力模型：Studio = 本地服务

**决策**：Studio 是用户机器上的本地服务。数据全在本地。引擎在本地。token 消耗在本地。

**否定方向**：
- ~~远程 server 跑引擎~~ → 消耗平台 token，不可持续
- ~~远程 server 存数据~~ → 公司数据不应上传到平台服务器

#### 架构

```
每个用户机器上：
  studio start
  → 本地 server（localhost:13001）
  → 本地数据（~/.studio/）
  → 本地引擎（Claude Code 等）
  → 浏览器访问 localhost

Studio Server ≠ 远程服务
Studio Server = 本地进程（每个用户自己跑）
```

#### 数据主权

```
Studio 提供：harness + channel + 角色 + 记忆系统（基建）
数据沉淀在：算力本地（.studio/）
Studio 不收集：用户的业务数据、代码、记忆、知识

Server 不存：
  ❌ 消息内容（协调用元数据除外）
  ❌ 记忆内容
  ❌ 知识条目
  ❌ WorkUnit 详情
  ❌ 任何业务上下文
```

#### 数据存储：md 文件

**决策**：用户数据全用 md 文件。零运行时依赖。LLM 原生可读。Git 友好。

```
| 数据类型 | 写频率 | 存储 |
|---|---|---|
| Channel 消息 | 高 | md（本地） |
| WorkUnit | 中 | md（本地） |
| Agent 记忆 | 低 | md（本地） |
| 知识条目 | 低 | md（已有 ~/.studio/knowledge/） |
| Agent 配置 | 极低 | md |
```

**理由**：
- 数据消费者是 LLM → md 直接可读，无需 DB 查询工具
- 数据量是单用户级别 → 不需要 SQLite 的查询性能
- 人类可读 → 直接看、直接编辑
- Git 追踪 → diff/merge 天然支持

#### 本地目录结构

```
~/.studio/                        # 个人全局（本地服务数据）
  ├── memory/                     # Agent 记忆
  ├── knowledge/                  # 全局知识（已有）
  └── config/                     # Studio 配置

~/projects/projectA/              # 项目 A
  ├── src/
  ├── docs/sdd/                   # 项目级 SDD（git 管理，团队共享）
  ├── CLAUDE.md                   # 项目约束
  └── ...
```

**知识分层**：

| 知识类型 | 位置 | 共享方式 |
|---|---|---|
| Agent 记忆 | `~/.studio/memory/` | 不共享（个人） |
| 个人知识 | `~/.studio/knowledge/` | 不共享（个人） |
| SDD | `project/docs/sdd/` | git（团队） |
| 项目模式/决策 | `project/docs/` | git（团队） |
| CLAUDE.md | `project/CLAUDE.md` | git（团队） |

#### Agent : Instance = 1:1

**决策**：1 个 AgentProfile 对应 1 个引擎进程。不可共享。

**原因**：LLM 上下文窗口 = 单一会话。一个进程只能有一个身份。

```
假设 Claude Code 进程 X 同时扮演 Pat(PM) + Hank(Engineer)：

System Prompt 冲突 → 一个进程只能有一个角色设定
Memory 注入污染 → Pat 的记忆 ≠ Hank 的记忆
对话上下文混乱 → 同时处理两个 Channel 的对话

→ 上下文污染，角色行为混乱
```

**结论**：引擎类型可复用（同一台机器 3 个 Claude Code 进程），但每个进程只能承载 1 个 AgentProfile。

### 项目绑定：Agent 如何知道在哪个工程工作

#### 问题

```
Agent 执行时需要知道：
  1. 有哪些项目（发现）
  2. 在哪个项目工作（绑定）
  3. 项目的上下文（CLAUDE.md + 代码）
```

#### Raft 做法（参考但不同）

```
Raft：Agent 有独立 workspace 目录 → 需要代码时 clone repo 进来
  → 适合 Agent 独立产出
  → 不适合在开发者已有项目上工作
```

#### Studio 做法：项目发现 + Channel 绑定

```
Studio 本地启动时：
  扫描 ~/projects/（或配置的根目录）
  → 检测项目（有 package.json / CLAUDE.md / .git）
  → 注册为 Project

Channel 关联 Project：
  Channel #前端 → Project: projectA
  Channel #后端 → Project: projectB

Agent 执行时：
  WorkUnit → channelId → projectId → project.path
  → spawn CLI，cwd = project.path
  → CLI 自动读取 project/CLAUDE.md
```

**关键**：Agent 不需要知道自己在哪个项目 — Channel 决定项目上下文，人通过选择 Channel 选择项目。

### 执行隔离：git worktree

#### 场景分析

```
单人本地（当前）：
  Agent 串行工作 → 不需要隔离 → 直接指向项目目录

多 Agent 并行（未来）：
  Agent-1 改 feature-a → Agent-2 改 feature-b
  → 需要目录隔离

开发模式：分支开发 + 发布线上
  每个需求 = 不同分支 → git worktree 天然提供隔离
  冲突只在 merge 时出现（不常见）
```

#### worktree 方案

```
WorkUnit 创建
  → 基于 main 创建 feature 分支
  → git worktree add（隔离目录）
  → Agent 在 worktree 目录执行
  → 完成 → commit → push → PR/merge
  → worktree remove

冲突？→ 正常 git merge 流程处理
```

#### Raft clone vs git worktree

| 维度 | Raft clone | git worktree |
|---|---|---|
| 隔离级别 | 完全隔离（独立 repo） | 分支隔离（同 repo） |
| 同步方式 | push/pull | merge |
| 和原项目关系 | 断开 | 连接 |
| 磁盘占用 | 完整副本 | 只存差异文件 |
| 适合场景 | Agent 独立产出 | 在已有项目上开发 |

**Studio 选择 worktree**：Agent 在开发者已有项目上工作，不是独立产出。分支模型 + worktree 隔离 = 和开发者日常工作流一致。

### Thread 驱动流转：WorkUnit × Skill × 角色

#### 问题

```
一个 WorkUnit 从需求到完成，经过 6 个阶段：
  设计 → Spec审查 → 任务规划 → SDD审查 → 实现 → 代码审查

涉及 3 个维度：
  角色（谁做）：PM(Pat) / DEV(Hank) / QA(Rin)
  Skill（怎么做）：design-analyst / spec-review / task-planner / sdd-review / tdd-implement / code-review
  阶段（做到哪）：6 个阶段

三个维度怎么统一？怎么流转？
```

#### 两个模型对比

**模型 A：状态机驱动**

```
WorkUnit.status = 'design' → Pat 看到 → 做 → 改 status = 'spec_review'
WorkUnit.status = 'spec_review' → Rin 看到 → 做 → 改 status = 'task_plan'
...

问题：硬编码流程 = Pipeline 换皮
  → 不灵活（简单需求不需要 6 步）
  → 不自然（人要插话改方向很难）
```

**模型 B：对话驱动（选定）**

```
@mention 传递 = 流转机制
Thread 上下文 = 隐含状态
Agent 读上下文 → LLM 判断用哪个 Skill

没有中央调度器，没有硬编码流程
```

#### 对话驱动流转示例

```
Thread（需求 A 的工作空间）

消息 1 [人]：@Pat 需求 A 是...
  → WorkUnit 创建，assigneeId=Pat

消息 2 [Pat]：分析了，产出 spec。（读 Thread → 用 design-analyst）
  @Rin 请审查
  → Rin 看到 @mention

消息 3 [Rin]：审查 spec，PASS。（读 Thread → 判断是 spec → 用 spec-review）
  @Pat 请出 SDD

消息 4 [Pat]：SDD 完成。（读 Thread → 用 task-planner）
  @Rin 请审查

消息 5 [Rin]：SDD PASS。（读 Thread → 判断是 SDD → 用 sdd-review）
  @Hank 请实现

消息 6 [Hank]：实现完成。（读 Thread → 用 tdd-implement）
  @Rin 请 review

消息 7 [Rin]：code review PASS。需求 A 完成。
```

#### 三维度统一

```
阶段：不需要显式定义。Thread 消息序列隐含阶段
角色：@mention 决定谁上
Skill：Agent 读 Thread 上下文，LLM 判断用哪个

流转机制：@mention 传递
  → 完成的人 @下一个人
  → 被 @的人看到 → 读上下文 → 选 Skill → 执行
```

#### 和 AgentProfile 最小设计的关系

```
AgentProfile = name + description + channels + memory
没有 role 字段，没有 skill 绑定

Rin 的 description = "审查所有产出物"
Rin 看到 @mention → 读 Thread 上下文 → LLM 判断该用 spec-review 还是 code-review

LLM 是能力引擎，不需要结构化路由
```

#### 并行场景

```
Thread 需求 A：Pat → Rin → Pat → Rin → Hank → Rin
Thread 需求 B：Pat → Rin → Hank → Rin（可能跳过某些步骤）
Thread 需求 C：Pat → Hank → Rin（简单需求，跳过设计审查）

3 个 Thread 独立流转，互不干扰
每个 Thread 有自己的消息历史（上下文）
Agent 在不同 Thread 间切换 = 在不同需求间切换
```

#### 核心优势

```
没有中央调度器
没有硬编码流程
@mention = 路由
Thread 上下文 = 状态
LLM = 决策引擎（选 Skill、判断下一步）
```

#### 比喻

```
Channel = 房间（#研发）
Thread = 桌子（需求 A / B / C）
WorkUnit = 议题（和 Thread 一一对应）
@mention = 传递话筒（做完交给下一个人）
Skill = 工具（Agent 根据上下文选）
Agent = 人（坐在房间里，看哪个桌子在叫自己）
```

---

## 九、待讨论

（全部已解决，见下方已解决清单）

### 已解决

- [x] ~~Agent 能力模型（capability）~~ → LLM 是能力引擎，不需要结构化字段
- [x] ~~引擎在哪运行~~ → 本地，用户的 CLI，用户的 token
- [x] ~~Agent 和引擎实例的比例~~ → 1:1，一个进程一个身份
- [x] ~~多角色 Channel 竞争~~ → @mention 绑定 assigneeId，人类是路由器
- [x] ~~Studio 是远程还是本地~~ → 本地服务，每个用户自己跑
- [x] ~~数据存储在哪~~ → 算力本地，Studio 不收集用户数据
- [x] ~~数据格式~~ → md 文件（LLM 原生可读，git 友好）
- [x] ~~Workspace 和 Computer 的关系~~ → 同一概念
- [x] ~~Agent 如何知道在哪个项目工作~~ → 项目发现 + Channel 绑定 Project
- [x] ~~Agent 执行隔离~~ → git worktree（分支级隔离）
- [x] ~~merge 冲突~~ → 不常见，正常 git merge 流程处理
- [x] ~~SDD 等知识的归属~~ → 项目级知识（git 共享），个人记忆（本地）
- [x] ~~WorkUnit 流转机制~~ → 对话驱动（@mention 传递），不是状态机
- [x] ~~Skill × 角色 × 阶段怎么统一~~ → @mention 决定角色，Thread 上下文决定 Skill
- [x] ~~并行上下文隔离~~ → Thread = 上下文边界，每次 spawn 按 Thread 注入
- [x] ~~持久化机制~~ → WorkUnit 内靠 Claude Code session，跨 WorkUnit 靠知识引擎飞轮
- [x] ~~Agent 记忆系统~~ → 不需要独立系统，复用知识引擎飞轮 + context 标签
- [x] ~~agentId 耦合~~ → 改为 context 标签（project + workType），知识跟场景走
- [x] ~~数据格式~~ → JSONL（日志型）+ md（内容型），按特性分
- [x] ~~知识存储位置~~ → 双层：个人 ~/.studio/knowledge/ + 项目 project/.studio/knowledge/
- [x] ~~知识消费方式~~ → MCP query_documents 按需查询，不注入
- [x] ~~双层知识可行性~~ → 已验证：LanceDB 单表 ingest 多目录，查询侧零改动
- [x] ~~AgentProfile.channels 启用策略~~ → Channel 管成员列表（创建时选 + 邀请/踢出），Agent 不需要 channels 字段
- [x] ~~记忆注入 token 预算~~ → 不需要注入，按需查询（MCP query_documents）
- [x] ~~记忆晋升触发条件~~ → 不需要晋升机制，知识按场景标签组织
