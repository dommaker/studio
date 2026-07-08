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

## 五、Agent 记忆 × 知识系统统一架构

### 核心洞察

知识系统的数据层（会话记录、Channel 消息、WorkUnit 结果）**天然就是 Agent 的情景记忆**。不需要另建记忆系统 — 需要在现有知识管线上加 agentId 维度。

### 三层记忆架构

```
Layer 3: 全局知识（shared knowledge）
  ├── 来源：所有 Agent 经验中可泛化的部分
  ├── 存储：~/.studio/knowledge/（现有）
  ├── 消费者：所有 Agent
  └── 提取：现有 PatternMiner + 知识合成

Layer 2: Agent 个人知识（per-agent knowledge）
  ├── 来源：该 Agent 的历史 WorkUnit + Channel 交互 + 人类反馈
  ├── 存储：~/.studio/memory/{agentId}/ 或 DB 字段
  ├── 消费者：仅该 Agent
  └── 提取：per-agent 知识蒸馏（新流程）

Layer 1: Agent 情景记忆（per-agent episodic memory）
  ├── 来源：该 Agent 的 WorkUnit 执行日志、Channel 消息、session 历史
  ├── 存储：ChannelMessage (workUnitId 关联) + WorkUnit metadata
  ├── 消费者：该 Agent 的 agentStep prompt 注入
  └── 提取：直接查询，不需要提取（原始数据）
```

### 数据→知识管线加 Agent 维度

```
                       ┌─────────────────────────────────────┐
                       │         数据层（raw）                │
                       │                                     │
  Channel 消息 ────────┤  agentId  tagging                   │
  WorkUnit 结果 ───────┤  每条数据带 agentId（谁产生的）       │
  Session 日志 ────────┤  或 null（系统级，非特定 Agent）      │
  审计事件 ────────────┤                                     │
                       └──────────┬──────────────────────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼              ▼
            ┌──────────┐  ┌──────────┐  ┌──────────────┐
            │ 全局数据  │  │ Pat 数据  │  │ Hank 数据     │
            │ agentId= │  │ agentId= │  │ agentId=     │
            │  null    │  │  Pat     │  │  Hank        │
            └────┬─────┘  └────┬─────┘  └────┬─────────┘
                 │              │              │
                 ▼              ▼              ▼
            ┌──────────┐  ┌──────────┐  ┌──────────┐
            │ 全局知识  │  │ Pat 记忆  │  │ Hank 记忆 │
            │ (现有)   │  │ (新增)   │  │ (新增)   │
            └──────────┘  └──────────┘  └──────────┘
```

### 记忆→知识的晋升路径

```
Agent 经验（情景记忆）
  ├──→ Per-agent 提炼 ──→ 个人知识（语义记忆 + 程序记忆）
  │                         「我学到：这类任务先跑测试再改代码」
  │
  └──→ 可泛化部分 ──────→ 全局知识（晋升）
                            「代码变更必须先过 tsc」
```

### Channel 在记忆架构中的角色

```
Channel = Agent 经验来源（情景记忆的产生地）

Agent 参与 Channel
  → 读 Channel 消息（情景记忆读取）
  → 在 Channel 中执行任务（情景记忆产生）
  → 人类在 Thread 中给反馈（语义记忆原料）
  → 任务完成/失败（程序记忆原料）
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
| Memory Store | per-agent 存储，复用 knowledge entry 格式，加 agentId 字段 |
| Retrieval API | MCP tool 扩展，query_documents 增加 agentId 参数 |
| Memory Lifecycle | 过期规则、晋升条件、审计规则（加 agentId 维度） |
| Data Tagging | WorkUnit/Channel 消息自动标记 agentId |
| studio-daemon | 用户机器守护进程：引擎发现、进程管理、server 长连接 |
| Workspace 注册 | daemon 连接 server + 引擎上报协议 |

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
Phase 1: Harness 基建 + Daemon（可与 Phase 2 并行）
  H1: studio-daemon（引擎发现 + server 长连接 + 进程管理）
  H2: Memory Store + agentId 标记
  H3: Retrieval API 扩展（MCP tool）
  H4: Lifecycle 规则

Phase 2: Studio 路由（不依赖新基建，立即做）
  S1: @mention → assigneeId 绑定
  S2: Convert to Task API
  S3: Agent 进度写入 Thread

Phase 3: Studio 记忆消费（依赖 Phase 1）
  S4: agentStep 记忆注入
  S5: 经验蒸馏（LLM）
  S6: Channel 历史读取

Phase 4: 闭环
  S7: 记忆晋升（per-agent → global）
  S8: Channel UI 记忆展示
```

---

## 七、缺口清单

> 注：#4 竞争无能力过滤 已被第八节设计决策解决（@mention 绑定 = 无竞争）。
> Agent 能力模型（capability）不再需要 — LLM 是能力引擎。

| # | 缺口 | 归属 | 优先级 | 改动量 |
|---|---|---|---|---|
| 1 | @mention 不绑定 assigneeId | Studio S1 | **P0** | 1 行 |
| 2 | listAgents 不过滤 RuntimeInstance 状态 | Studio | P2 | 中 |
| 3 | Agent.channels 为空时看全部（无隔离） | Studio S3 | P3 | 低 |
| ~~4~~ | ~~竞争无能力过滤~~ | — | — | **已解决：@mention 绑定** |
| 5 | 无 @mention 消息不涌现 WorkUnit | Studio S2 | P2 | ~50 行 |
| 6 | Agent 进度不在 Thread 内 | Studio S3 | P2 | ~20 行 |
| 7 | Agent 不读 Channel 历史 | Studio S6 | P3 | ~40 行 |
| 8 | Per-agent 记忆存储 | Harness H1 | P2 | 中 |
| 9 | Per-agent 记忆检索 | Harness H2 | P3 | 中 |
| 10 | agentStep 记忆注入 | Studio S4 | P3 | 中 |
| 11 | 经验蒸馏（LLM） | Studio S5 | 长期 | 大 |
| 12 | 记忆晋升 | Studio S7 | 长期 | 中 |
| 13 | studio-daemon（引擎发现+进程管理） | Harness H1 | **P0** | 大 |
| 14 | Workspace 注册协议（daemon↔server） | Harness H1 | **P0** | 中 |
| 15 | Agent 执行迁移到 daemon（server 不再 spawn CLI） | Harness | P1 | 大 |

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

### 算力模型：用户自带，服务器协调

**决策**：引擎跑在用户机器上，用用户的 CLI，消耗用户的 token。Studio server 只做协调。

**错误方向（已否定）**：服务器跑引擎 → 消耗服务器 token → 不可持续。

#### Raft 参考实现

```
1. 用户在机器上安装 daemon
   $ raft-computer setup my-server

2. daemon 连 server，上报本机引擎
   → 扫描 PATH → [claude, codex, opencode]
   → server 记录 Computer.runtimes

3. 用户在 UI 创建 Agent，选 Computer + 选 runtime
   → Agent 进程跑在用户机器上
```

#### Studio 实体模型

```
Studio Server（协调层，零 token 消耗）
  ├── Channel（消息路由）
  ├── WorkUnit（任务管理）
  ├── AgentProfile（身份：name + desc + channels + memory）
  │
  └── Workspace（= Computer = 用户机器）
        ├── daemon（长连接 server）
        ├── 引擎（claude / codex / opencode，用户已安装）
        └── RuntimeInstance（引擎进程，daemon 管理）
```

**Workspace = Computer**：AS-023 的 Workspace 概念直接对应 Raft 的 Computer。不是两个东西。

#### 职责划分

| 职责 | Server | Workspace |
|---|---|---|
| 消息路由/存储 | ✅ | — |
| WorkUnit 调度 | ✅ | — |
| AgentProfile 持久化 | ✅ | — |
| 引擎进程管理 | — | ✅（daemon） |
| 任务执行 | — | ✅（CLI 进程） |
| token 消耗 | — | ✅（用户 API key） |
| 引擎发现 | — | ✅（daemon 扫描上报） |

#### 引擎发现流程

```
Workspace daemon 启动
  → 扫描本机 PATH 中的 CLI 工具
  → 上报 server: { computerId, runtimes: ["claude-code", "codex", "opencode"] }
  → server 存储为 Workspace.runtimes

用户创建 Agent
  → UI 显示该 Workspace 可用引擎列表
  → 用户选择引擎 + 填 name/description/channels
  → server 创建 AgentProfile
  → daemon 收到指令 → spawn 引擎进程 = RuntimeInstance
```

#### Agent : Instance = 1:1

**决策**：1 个 AgentProfile 对应 1 个引擎进程。不可共享。

**原因**：LLM 上下文窗口 = 单一会话。一个进程只有一个上下文。

```
假设 Claude Code 进程 X 同时扮演 Pat(PM) + Hank(Engineer)：

System Prompt 冲突 → 一个进程只能有一个角色设定
Memory 注入污染 → Pat 的记忆 ≠ Hank 的记忆
对话上下文混乱 → 同时处理两个 Channel 的对话

→ 上下文污染，角色行为混乱
```

**结论**：引擎类型可以复用（同一台机器 3 个 Claude Code 进程），但每个进程只能承载 1 个 AgentProfile。

```
机器上装了 Claude Code（引擎类型）
  → 3 个 Claude Code 进程（3 个实例）
  → 进程 1 = Pat，进程 2 = Hank，进程 3 = Rin
  → 空闲时 idle（进程存活，低资源）
  → 忙碌时各自处理 WorkUnit
```

#### 需要的 Studio 组件（新增）

| 组件 | 当前 | 需要 |
|---|---|---|
| studio-daemon | ❌ 无 | 新建（类 raft-computer） |
| Workspace 注册 | ❌ 无 | daemon 连接 + 引擎上报 |
| Runtime 发现 | 硬编码 Claude Code | daemon 扫描 PATH 上报 |
| Agent 执行 | server spawn CLI | daemon spawn CLI |
| API key | server 环境变量 | 用户机器本地配置 |

---

## 九、待讨论

- [ ] AgentProfile.channels 的启用策略：创建时绑定 vs 自主 join？
- [ ] Per-agent 记忆的存储位置：文件系统 vs DB？
- [ ] 记忆注入的 token 预算如何控制？
- [ ] Convert to Task 是否需要 LLM 辅助判断 scope？
- [ ] 记忆晋升的触发条件：被多少 Agent 引用后晋升？

### 已解决

- [x] ~~Agent 能力模型（capability）~~ → LLM 是能力引擎，不需要结构化字段
- [x] ~~Agent 创建流程~~ → Workspace daemon 上报引擎 → 用户 UI 选择引擎+填身份
- [x] ~~引擎在哪运行~~ → 用户机器，用户的 CLI，用户的 token
- [x] ~~Workspace 和 Computer 的关系~~ → 同一概念，Workspace = Computer
- [x] ~~Agent 和引擎实例的比例~~ → 1:1，一个进程一个身份
- [x] ~~多角色 Channel 竞争~~ → @mention 绑定 assigneeId，人类是路由器
