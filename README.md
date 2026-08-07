# Agent Studio

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D8-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)

**多智能体协作平台** —— 人在频道里 **@角色** 派活，角色（持久 AgentProfile，由 agent CLI 执行）在**隔离的 git worktree** 里干活，产物经**自动验证**、**独立评审**后**自动合并**回主干，进度自动回写 PMO 项目。数据存储全部走 FileStore（`~/.studio/`），无数据库依赖。

> 架构与定位的「宪法」是 [docs/vision-2026.md](docs/vision-2026.md)，本文与之冲突时以 vision 为准。

## 为什么选择 Studio

agent CLI 本身就能干活，Studio 做的是任务级编排：

- **持久角色** —— agent 是有名字、有职责、有频道成员身份的持久配置（AgentProfile），不是一次性会话
- **无人值守交付链** —— 认领 → worktree 隔离执行 → 验证 → 评审 → 合并 → 进度回写，全链路不需要人盯
- **跨会话知识复利** —— 执行沉淀的知识/约束注入后续任务（≤ 2K tokens/任务），越用越聪明
- **可观测与治理** —— 多任务、多工程、多 agent 的状态、开销与人工干预率集中可见

Studio 不复刻 CLI 能力（@文件、diff 预览等不做），只产出任务描述 + 上下文注入，交给 agent CLI（claude / kimi / codex / opencode）在目标工程的隔离 worktree 内执行。

## 核心链路

```
人 ──频道消息──▶ @mention 路由（以 channel.members 为界匹配；@studio 改派 pm）
                      │ 创建 WorkUnit（绑定 REQ 编号 + 工程归属）
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
                自动合并（git merge --no-ff 回 base 分支；冲突 rebase 重试一次，再败转人工）
                      │
                      ▼
                done ──▶ Requirement 状态汇总 + PMO 项目进度回写 + 知识飞轮提取
```

- **双向沟通**：agent 执行中遇疑问/阻塞，以 `NEED_INPUT` 在频道向人提问并挂起；人在该线程回复后自动续跑。
- **REQ 需求编号**：一个需求（`REQ-<序号>`）= 一组 WorkUnit，@mention 派发时绑定，UI 按编号串联全链路。
- **agent→agent 委派**：支持 `DELEGATE` 协议，由 DelegationGate 限制委派深度与次数，防无限裂变。
- **工程归属链**：`OKR → PMO 项目（gitRepo 为工程锚点）→ Requirement → WorkUnit`；无归属时 WU 挂起并频道询问，人回复工程名后自动解析复活（`modules/requirements/ownership-resolver.ts`）。

## 快速开始

前置要求：Node.js >= 18、pnpm >= 8、git；至少安装一家 agent CLI（**claude / kimi / codex / opencode**）。

```bash
pnpm install
pnpm dev                 # 各包 watch 模式
# 或起完整开发实例（API + Web，缺省端口 13001/13000）：
pnpm dev:start           # 配套 dev:stop / dev:status / dev:logs
```

```bash
./bin/studio up          # 启动 API（preflight 自检，托管前端 dist，http://localhost:3001）
pnpm test                # vitest 全量
pnpm typecheck           # tsc-gate 类型门禁
```

生产 API 由 systemd `studio-api.service` 管理；部署/启停自动化在私有运维仓，详见 [scripts/README.md](scripts/README.md)。

## 项目结构

```
apps/
  api/            # 后端：Express 路由 + AgentLoop 编排 + FileStore 持久化
  web/            # 前端：React + Vite + Tailwind，频道/PMO/知识库 UI
packages/
  studio-agent/   # agent CLI 执行与 runner 协议
  studio-audit/   # 审计与告警通知
  studio-capability/  # 能力清单
  studio-notification/ # 通知渠道
  studio-shared/  # 共享类型、FileStore、provider 配置
  studio-skill/   # skill 解析与注入
  studio-spec/    # SDD 规格与门禁校验
```

## 内置角色

启动时幂等 seed（已存在不覆盖用户改动，被禁用不自动复活）：

| 角色 | 职责 | 接单类型 |
|------|------|----------|
| **pm** | 需求澄清、设计、拆解（`@studio` 的改派目标） | analysis / feature / task |
| **dev** | 代码实现与修复 | task / bug / feature / refactor |
| **reviewer** | 独立评审：SDD 文档与代码 diff | review / analysis |
| **studio** | 系统身份，不接任务 | — |

## 可观测

- **监控端点** `/api/v1/monitoring/*`（admin）：agents / stats / overhead（注入 tokens 与开销比红线）/ flywheel（知识飞轮健康度）/ overview（聚合大盘，北极星指标 = 每完成 WU 平均人工介入次数；数据不足显式返回 `null`，不编造数字）。
- **日志** `~/.studio/logs/`：任务执行 jsonl（时长/token/错误分类）、API 审计、统一事件流、异常事件。
- **traceId 链路**：请求 requestId → WU `metadata.traceId` → 注入 CLI 的 `STUDIO_TRACE_ID`，串起「请求 → WU → 执行日志」。
- **告警出口**：频道系统消息 + 企业微信 webhook 双 sink，各自独立降级。

## 知识飞轮

闭环：`执行 → 提取 → 存储 → 注入 → 反馈 → 进化`。任务 COMPLETE 时自动做一次 LLM 提取（根因/模式/用户偏好），写入单一运行时知识库 `~/.studio/knowledge`，审核通过后才参与后续任务的注入（≤ 2K tokens/任务）。健康度看 `/api/v1/monitoring/flywheel` 与 `/overhead`。

## 配置

配置来源：进程环境变量 > `STUDIO_CONFIG_DIR` 下的 `.env` > `~/.studio/config.env`。关键变量：

| 变量 | 用途 |
|------|------|
| `JWT_SECRET` | 登录会话签名密钥，生产必须设置，缺失拒绝启动 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 首次启动自动创建 admin 账号 |
| `STUDIO_PROJECTS_ROOT` | 本地工程发现根目录（冒号分隔，默认 `~/projects`） |
| `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `LLM_API_KEY` | 内部 LLM 调用密钥，按序探测 |
| `WECOM_WEBHOOK_URL` | 企业微信告警 webhook（可选） |

完整变量清单（存储路径、开关、通知渠道等）见 [.env.example](.env.example)；执行任务的 agent CLI 密钥由各 CLI 自身管理。运行时可执行 `./bin/studio config` 查看/修改。

## 文档地图

| 文档 | 作用 |
|------|------|
| [docs/vision-2026.md](docs/vision-2026.md) | 定位与主干设计共识（宪法），含三期演进路线 |
| [docs/plans/](docs/plans/) | 演进计划 |
| [docs/sdd/](docs/sdd/) | 变更规格（SDD），按变更立项 |
| [CAPABILITIES.md](CAPABILITIES.md) | 能力清单（自动维护） |
| [AGENTS.md](AGENTS.md) | agent 导读与模块索引（机器维护；手写指南在 CLAUDE.md） |
| [scripts/README.md](scripts/README.md) | 脚本与运维命令细节 |

## License

MIT © dommaker
