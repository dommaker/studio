# Agent Studio

**AI Agent OS** — Goal 驱动，Agent 自主执行，人退居审批者。

```
用户 → Channel #研发 → @Analyst → RequirementsDoc → Goal → Executor → Reviewer → Deploy
                                                                        ↓
                                                              Knowledge Agent → KK 提取
```

---

## 快速开始

```bash
git clone https://github.com/dommaker/studio.git
cd studio
pnpm install && pnpm db:migrate && pnpm dev:start
```

**端口**：前端 http://localhost:5173 | API http://localhost:3001 | SSE `/api/v1/events/stream`

---

## 核心能力

### 管线

| 能力 | 状态 | 说明 |
|------|:--:|------|
| Goal 驱动 | ✅ | 人定义需求 → Agent 自主执行 → Reviewer 多立场审查 → Deploy |
| Channel UI | ✅ | #研发 / #系统，SSE 实时推送，卡片交互 |
| 知识引擎 | ✅ | KnowledgeAgent 提取 + Evolution 三层进化 + 五大缺口覆盖 |
| MCP Server | ✅ | 32 tools，JSON-RPC 2.0，HTTP + REST |
| CLI | ✅ | 统一入口 `studio`，25 个命令，全部走 HTTP API |
| Agent 执行 | ✅ | git worktree 隔离 + async spawn + `.progress.json` |
| 4 Agent 体系 | ✅ | Executor / Review / Knowledge / Monitor，Agent≠岗位 |
| Auditor | ✅ | 每日审计 + 自动建议 + EvalCase 飞轮 |
| Triage | ✅ | 11 事件类型 + 自动诊断 + 升级 |
| Harness 约束 | ✅ | Iron Laws + Guidelines + Tips，10/10 hook active |
| 知识缺口 | ✅ | G-001~005: 偏好/规则/环境/决策链/交互模式 |
| Discord | ✅ | 斜杠命令 + 通知 + tmux 桥接 |

### 技术栈

| 能力 | 实现 |
|------|------|
| 数据库 | SQLite (Prisma) |
| 事件 | EventEmitter (进程内) |
| 推送 | SSE (EventSource) |
| 部署 | 单进程 Node.js |
| 测试 | vitest (66 pass) |

---

## 架构

### 当前执行流

```
用户 → ChannelList (频道首页)
  → #研发 → ≥30字 + @Analyst → RequirementsDoc (AcGroup 分组)
  → [开始执行] 按钮 → Goal + GoalPlan(approved) + GoalExecutions
  → GoalScheduler 分发 → N 个并行 Execution
  → AgentExecutor.execute() → git worktree add → spawn Claude Code
  → 读 .progress.json → checkBeforeTaskComplete
  → 全部完成 → Reviewer 多立场审查 → 放行/打回/escalate (max 3轮)
  → Deploy 检查 → KK 提取知识 → knowledge_confirm 卡片 → #系统
```

### Packages (9)

| Package | 用途 |
|---------|------|
| studio-shared | Logger, LLM client, EventBus, harness wrapper |
| studio-prisma | Prisma schema + client (SQLite) |
| studio-agent | AgentExecutor — spawn session loop |
| studio-task | TaskQueue + TaskWorker |
| studio-spec | GateChecker + 变更分析 + Spec 验证 |
| studio-audit | 审计日志服务 |
| studio-monitor | 健康监控 (5min) |
| studio-notification | 通知服务 |
| studio-capability | 能力/技能池管理 |

---

## CLI (25 commands)

```
studio
├── up / stop / restart / logs / status   服务管理
├── db <push|migrate|status>              数据库
├── run / pipeline / metrics              执行
├── goal / knowledge / channel / role      数据查询
├── task / agent / env / mcp / skill      系统管理
├── approve / reject                      审批
└── project / workon / daemon             项目管理
```

全部通过 HTTP API，不直接访问 DB。

---

## 开发命令

```bash
pnpm dev:start          # 启动所有服务
pnpm dev:stop           # 停止所有服务
pnpm build              # 构建所有包
pnpm test               # 运行测试 (vitest)
pnpm db:generate        # 生成 Prisma client
pnpm db:migrate         # 运行迁移
```

---

## 依赖

| 包 | 版本 | 用途 |
|------|:--:|------|
| @dommaker/harness | 0.12.2 | 约束框架 + 知识引擎 + 安全护栏 |
| @dommaker/studio-toolbox | 0.1.0 | 工具定义层 (待接入) |

---

## 配置

关键环境变量：

```bash
PORT=3001                        # API 端口（默认，可自定义）
DATABASE_URL=file:./data.db       # SQLite 路径
JWT_SECRET=<random-32-chars>      # JWT 签名密钥
ENCRYPTION_KEY=<random-32-chars>  # LLM 配置加密密钥
```

完整配置说明见 [docs/configuration.md](docs/configuration.md)。

---

## License

MIT © dommaker
