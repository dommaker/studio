# Agent Studio

**多智能体协作平台** —— 人在频道里 **@角色** 派活，角色（持久 AgentProfile，由 agent CLI 执行）在**隔离的 git worktree** 里干活，产物经**自动验证**、**独立评审**后**自动合并**回主干，进度自动回写 PMO 项目。数据存储全部走 FileStore（`~/.studio/`），无数据库依赖。

> 架构与定位的「宪法」是 [docs/vision-2026.md](docs/vision-2026.md)，本文与之冲突时以 vision 为准。

## 与直接跑 CLI 的区别

既然 agent CLI 本身就能干活，Studio 存在的理由是：

- **持久角色**：agent 是有名字、有职责、有频道成员身份的持久配置（AgentProfile），不是一次性会话；
- **无人值守交付链**：认领 → worktree 隔离执行 → 验证 → 评审 → 合并 → 进度回写，全链路不需要人盯；
- **跨会话知识复利**：执行沉淀的知识/约束会注入后续任务（≤ 2K tokens/任务），越用越聪明——CLI 单轮交互没有这个；
- **可观测与治理**：多任务、多工程、多 agent 的状态、开销与人工干预率集中可见（见「可观测」）。

Studio 不复刻 CLI 能力（@文件、diff 预览等不做），只做任务级编排：产出任务描述 + 上下文注入，交给 agent CLI 在目标工程的隔离 worktree 内执行。

## 核心链路

```
人 ──频道消息──▶ @mention 路由（以 channel.members 为界匹配；@studio 改派 pm）
                      │ 创建 WorkUnit（绑定 REQ 编号 + 工程归属，见下节）
                      ▼
                AgentLoop 认领（observe→claim→step，每个活跃角色一个 loop）
                      │ 代码类 WU（task/bug/feature/refactor）强制专属 worktree
                      ▼
                agent CLI 在 worktree 执行（分支 task/<wuId>；注入 skill/知识 ≤2K tokens）
                      │ 完成
                      ▼
                自动验证（工程验证命令；失败输出尾部回灌 agent 修复，连续失败 3 次转 blocked）
                      │ 通过 → in_review
                      ▼
                ReviewDispatcher 代派 reviewer（review 子 WU，独立评审）
                      │ reviewPassed（report 缺失/不可解析 → 转人工，不默认拒绝）
                      ▼
                自动合并（git merge --no-ff 回 base 分支；冲突转人工 blocked）
                      │
                      ▼
                done ──▶ Requirement 状态汇总 + PMO 项目进度回写 + 知识飞轮提取
```

- **双向沟通**：agent 执行中遇到疑问/阻塞，以 `NEED_INPUT` 在频道向人提问并挂起；人在该线程回复后自动续跑。
- **REQ 需求编号**：一个需求（`REQ-<序号>`）= 一组 WorkUnit，@mention 派发时绑定（显式指定 > 消息中 `#REQ-XXXX` token > 自动新建），UI 按编号串联全链路（vision §5.3）。
- **agent→agent 委派**：支持 `DELEGATE` 协议，由 DelegationGate 限制委派深度与次数，防无限裂变。
- **merge 冲突**：自动合并失败会 rebase 重试一次；仍冲突则清理现场、频道发系统消息转人工，WU 置 blocked。

## 归属链（工程从哪来）

第一性归属链，频道绑定只是默认提示：

```
OKR → PMO 项目（gitRepo 为工程锚点）→ Requirement（挂 PMO 项目）→ WorkUnit（继承工程）
```

创建 WU 时按优先级解析（`modules/requirements/ownership-resolver.ts`）：

1. 显式 `workspaceId`（API 调用方指定）；
2. `Requirement.projectId` → PMO 项目 `gitRepo`（第一性归属，结果落档 `metadata.workspaceRoot`）；
3. 频道 `defaultWorkspaceId`（降级为默认提示）；
4. **无归属**：WU 照常创建但立即 NEED_INPUT 挂起，频道发系统消息问「这个任务要修改哪个工程？」；人在线程回复工程名/路径后自动解析复活。

各步独立容错：单步读取失败仅记日志并落到下一优先级，归属解析绝不阻断 WorkUnit 创建。

## 内置角色

启动时幂等 seed（`modules/agents/builtin-roles.ts`）：已存在不覆盖用户改动，被禁用不自动复活。

| 角色 | 职责 | 接单类型 | 说明 |
|------|------|----------|------|
| **pm** | 需求澄清、设计、拆解 | analysis / feature / task | `@studio` 的改派目标 |
| **dev** | 代码实现与修复 | task / bug / feature / refactor | |
| **reviewer** | 独立评审：SDD 文档与代码 diff | review / analysis | WU 进 in_review 时由 ReviewDispatcher 状态机代派，不走 DELEGATE |
| **studio** | 系统身份（启动幂等创建） | 不接任务 | `@studio` 自动改派 pm，并在频道发系统消息说明 |

## 环境变量

配置来源：进程环境变量 > `STUDIO_CONFIG_DIR` 指向的 `.env` > `~/.studio/config.env`（`./bin/studio config` 可查看/修改）。下表只列变量名与用途，密钥值请自行生成。

### 核心运行

| 变量 | 用途 | 说明/示例 |
|------|------|-----------|
| `PORT` | HTTP 端口 | 默认 `3001` |
| `STUDIO_CONFIG_DIR` | 配置目录 | 启动时加载其下 `.env`（不覆盖已存在的进程环境变量）；未设置走 `~/.studio` 默认路径 |
| `JWT_SECRET` | 登录会话 JWT 签名密钥 | 生产环境必须设置，缺失即拒绝启动 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 首次启动自动创建 admin 账号 | email 缺省 `admin@localhost`；密码未设置则跳过自动创建 |
| `ENCRYPTION_KEY` | 敏感配置落盘加密密钥 | 见 `.env.example` |

### 工程发现与归属

| 变量 | 用途 | 说明/示例 |
|------|------|-----------|
| `STUDIO_PROJECTS_ROOT` | 本地工程发现根目录 | 冒号分隔多个，默认 `~/projects`；无归属挂起时人回复的工程名在此清单中匹配 |
| `STUDIO_PROJECTS_EXCLUDE` | 工程发现排除清单 | 冒号分隔；目录名精确匹配或绝对路径前缀，命中即跳过且不递归 |

### LLM（内部调用：知识提取、总结、扫描等）

| 变量 | 用途 | 说明/示例 |
|------|------|-----------|
| `DEEPSEEK_API_KEY`（+`DEEPSEEK_BASE_URL`/`DEEPSEEK_MODEL`）、`OPENAI_API_KEY` 或 `LLM_API_KEY`（+`LLM_BASE_URL`/`LLM_MODEL`） | provider 级密钥 | 按序探测，先中先用 |
| `LLM_API_KEY_USER` / `LLM_BASE_URL_USER` / `LLM_MODEL_USER` | 用户级覆盖 | 优先级最高 |
| `STUDIO_BASE_URL` / `STUDIO_API_KEY` | 历史统一 LLM 密钥对 | 仍残留于 `~/.studio/config.env`；当前代码已不读取（走上面的 provider key），列出以免误配 |

注意：执行任务的 agent CLI（claude/kimi/codex/opencode）的密钥由各 CLI 自身配置管理，不在本表。

### 告警通知

| 变量 | 用途 | 说明/示例 |
|------|------|-----------|
| `WECOM_WEBHOOK_URL` | 企业微信群机器人 webhook | 设置后告警 POST markdown 消息（5s 超时）；未配置跳过该 sink |
| `STUDIO_ALERT_CHANNEL_ID` | 告警频道 id | 未设置时回落到名为「系统」/system 的频道；都没有则跳过频道 sink |
| `DISCORD_DAILY_CHANNEL` | Discord 通知频道 | 可选渠道（`utils/discord-notifier.ts`） |

### 存储路径（均有默认值，一般无需设置）

| 变量 | 用途 | 说明/示例 |
|------|------|-----------|
| `WORKTREES_DIR` | worktree 根目录 | 默认 `~/.studio/worktrees` |
| `STUDIO_EVENTS_DIR` / `EVENTS_DIR` | 事件目录 | 默认 `~/.studio/events`；同设时 `STUDIO_EVENTS_DIR` 优先 |
| `KNOWLEDGE_DIR` | harness 知识存储目录 | 未设置时按入口回退（`studio up` → `~/.studio/knowledge`，直启 index.ts → `apps/api/.harness/knowledge`）；运行时知识库统一路径为 `~/.studio/knowledge` |
| `STUDIO_EVENTS_FILE` | 统一事件文件整体覆盖 | 测试隔离/应急切换用；默认 `~/.studio/logs/studio-events.jsonl` |

### 开关

| 变量 | 用途 | 说明/示例 |
|------|------|-----------|
| `CLOUDFLARED_ENABLED` | 公网 quick tunnel（Discord interactions 用） | 默认开；`=false` 关闭 |
| `EVOLUTION_ENABLED` | 约束进化每日扫描 + 频道审核 watcher | 默认开；`=false` 关闭 |

## 运行方式

### 开发

前置要求：Node.js >= 18、pnpm >= 8、git；至少安装一家 agent CLI（**claude / kimi / codex / opencode**，provider 配置见 `packages/studio-shared/src/providers.ts`）。

```bash
pnpm install
pnpm dev                 # 各包 watch 模式（pnpm -r dev）
# 或起完整开发实例（API + Web，读 .env.beta，缺省端口 13001/13000）：
pnpm dev:start           # = scripts/dev/start.sh；配套 dev:stop / dev:status / dev:logs
pnpm dev:api             # 只起 API（tsx watch）
pnpm dev:web             # 只起前端（Vite 热更新）
```

### 生产

- 生产 API 由 systemd **`studio-api.service`** 统一管理（`Restart=always`）：`systemctl restart studio-api.service`，日志 `journalctl -u studio-api.service`。
- 禁止用 pm2 / nohup 另起进程（多监管者互抢端口）；部署/启停自动化维护在私有运维仓，本仓只保留通用 `pnpm start`（= `npx tsx apps/api/src/index.ts`）。

### 常用命令

```bash
pnpm test                # vitest 全量
pnpm test:api            # 只跑 API 包测试
pnpm typecheck           # tsc-gate 类型门禁（baseline 比对）
./bin/studio up          # 启动 API（preflight 自检，托管前端 dist，http://localhost:3001）
./bin/studio status      # 健康检查；stop/restart/test/approve/config 等见 ./bin/studio 不带参数运行
```

## 可观测

### 监控端点

`/api/v1/monitoring/*`（需 admin 权限）：

| 端点 | 内容 |
|------|------|
| `GET /agents` | AgentProfile + 运行实例聚合 |
| `GET /stats` | WorkUnit / Agent / 近期统计 |
| `GET /overhead` | 封装开销：注入 tokens vs 2K 红线、开销比 vs 1.2x 红线、知识提取 tokens |
| `GET /flywheel` | 飞轮指标：注入命中率 / 知识质量 / 新鲜度 / 待审 proposal / 提取活动 |
| `GET /overview?windowDays=7` | D16 聚合大盘：任务流健康、入口转化、**人工干预（北极星：每完成 WU 平均人工介入次数）**、端到端周期、角色维度、工程质量（验证通过率/冲突/自动合并数）、Token 归因、告警量 |

`overview` 窗口 1–90 天（默认 7），60s 缓存；数据不足时显式返回 `null` + `insufficient-data`，不编造数字。

### 日志文件

均在 `~/.studio/logs/` 下（测试运行自动隔离到 `os.tmpdir()/studio-test-logs/`，不污染生产日志）：

| 文件 | 内容 |
|------|------|
| `tasks-YYYY-MM-DD.jsonl` | 任务执行逐条记录：时长、token 用量、错误分类 |
| `audit.jsonl` | API 关键操作审计，含 `requestId` |
| `studio-events.jsonl` | 统一事件流（D18 唯一入口）：`workunit:tokens`、`monitor:alert`、`knowledge:*` 等 |
| `incidents.jsonl` | 异常事件（triage / OKR 异常检测） |

### traceId 链路

audit 中间件为每个请求确保 `requestId`（复用 `x-request-id` 头）→ 频道消息 POST 将其作为 `traceId` 传入路由 → @mention 建 WU 时写入 `metadata.traceId` → agent-loop 日志行与注入 CLI 的 `STUDIO_TRACE_ID` 环境变量同值，串起「请求 → WU → 执行日志」全链路。

### 告警出口

`notifyAlert`（`apps/api/src/utils/notifier.ts`）fire-and-forget 双 sink：告警频道系统消息 + 企业微信 webhook，各自独立降级，sink 失败仅记日志。

## 知识飞轮

闭环：`执行 → 提取 → 存储 → 注入 → 反馈 → 进化`。任务 COMPLETE 时自动做一次 LLM 提取（根因/模式/用户偏好），写入单一运行时知识库 `~/.studio/knowledge`，审核通过后才参与后续任务的注入（≤ 2K tokens/任务）。健康度看 `/api/v1/monitoring/flywheel` 与 `/overhead`。

## 文档地图

| 文档 | 作用 |
|------|------|
| [docs/vision-2026.md](docs/vision-2026.md) | 定位与主干设计共识（宪法），含三期演进路线 |
| [docs/plans/](docs/plans/) | 演进计划：一期 `2026-07-mvp-fix-plan.md`（修通最小闭环），二期 `2026-07-flywheel-repair.md`（飞轮通数据）等 |
| [docs/sdd/](docs/sdd/) | 变更规格（SDD），按变更立项 |
| [CAPABILITIES.md](CAPABILITIES.md) | 能力清单（harness `sync-docs` 自动维护） |
| [AGENTS.md](AGENTS.md) | agent 导读与模块索引（纯机器维护，用 `pnpm agents-md:sync` 重建；手写 agent 指南在 CLAUDE.md） |
| [scripts/README.md](scripts/README.md) | 脚本与运维命令细节（含 systemd 约定） |

## License

MIT © dommaker
