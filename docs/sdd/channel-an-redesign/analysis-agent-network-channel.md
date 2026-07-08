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
Phase 1: Harness 基建（可与 Phase 2 并行）
  H1: Memory Store + agentId 标记
  H2: Retrieval API 扩展（MCP tool）
  H3: Lifecycle 规则

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

| # | 缺口 | 归属 | 优先级 | 改动量 |
|---|---|---|---|---|
| 1 | @mention 不绑定 assigneeId | Studio S1 | P1 | 1 行 |
| 2 | listAgents 不过滤 RuntimeInstance 状态 | Studio | P2 | 中 |
| 3 | Agent.channels 为空时看全部（无隔离） | Studio S3 | P3 | 低 |
| 4 | 竞争无能力过滤（先到先得） | Studio | P3 | 高 |
| 5 | 无 @mention 消息不涌现 WorkUnit | Studio S2 | P2 | ~50 行 |
| 6 | Agent 进度不在 Thread 内 | Studio S3 | P2 | ~20 行 |
| 7 | Agent 不读 Channel 历史 | Studio S6 | P3 | ~40 行 |
| 8 | Per-agent 记忆存储 | Harness H1 | P2 | 中 |
| 9 | Per-agent 记忆检索 | Harness H2 | P3 | 中 |
| 10 | agentStep 记忆注入 | Studio S4 | P3 | 中 |
| 11 | 经验蒸馏（LLM） | Studio S5 | 长期 | 大 |
| 12 | 记忆晋升 | Studio S7 | 长期 | 中 |

---

## 八、待讨论

- [ ] AgentProfile.channels 的启用策略：创建时绑定 vs 自主 join？
- [ ] Per-agent 记忆的存储位置：文件系统 vs DB？
- [ ] 记忆注入的 token 预算如何控制？
- [ ] Convert to Task 是否需要 LLM 辅助判断 scope？
- [ ] Agent 能力模型（capability）如何设计？影响竞争过滤。
- [ ] 记忆晋升的触发条件：被多少 Agent 引用后晋升？
