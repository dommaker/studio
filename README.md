# Agent Studio

**多 Agent 群聊控制台** —— 一个薄编排层，只做三件事：**任务派发**（人在频道提需求，派给 agent CLI 执行）、**状态监控**（任务/角色/工程状态可观测，开销可度量）、**知识飞轮**（执行数据沉淀为知识，再注入后续执行）。

```
人 ──频道发消息──▶ @mention 匹配角色 ──▶ 创建 WorkUnit ──▶ AgentLoop ──▶ agent CLI ──▶ 结果回写频道
```

> 架构与定位的「宪法」是 [docs/vision-2026.md](docs/vision-2026.md)，本文与之冲突时以 vision 为准。

## 与直接跑 CLI 的区别

既然 agent CLI 本身就能干活，Studio 存在的理由是：

- **持久角色**：agent 是有名字、有职责、有频道成员身份的持久配置（AgentProfile），不是一次性会话；
- **跨会话知识复利**：执行沉淀的知识/约束会注入后续任务，越用越聪明——CLI 单轮交互没有这个；
- **可观测与治理**：多任务、多工程、多 agent 的状态与 token 开销集中可见，需求全链路可追踪。

Studio 不复刻 CLI 能力（@文件、diff 预览等不做），只做任务级派发：产出任务描述 + 上下文注入（≤ 2K tokens），交给 agent CLI 在目标工程内执行。

## 前置要求

- Node.js >= 18，pnpm >= 8，git
- 至少安装一家 agent CLI：**claude / kimi / codex / opencode**（provider 配置见 `packages/studio-shared/src/providers.ts`）

## 快速开始

```bash
git clone https://github.com/dommaker/studio.git
cd studio
pnpm install
./bin/studio up        # 或 pnpm start；首次启动自动构建前端并托管
```

打开 **http://localhost:3001**（API 同端口，SSE 推送在 `/api/v1/events/stream`），然后：

1. 在 Web UI 创建一个角色（选择 provider CLI，可用 `.agents/roles/*.yaml` 预设模板）并激活；
2. 把角色加入频道，在频道里 **@mention** 它发一条需求；
3. 系统自动创建 WorkUnit，AgentLoop 认领后 spawn 对应 CLI 执行，结果回写频道。

也可以直接用 CLI 派发（发到 #研发 频道并 @Analyst）：

```bash
./bin/studio run "给登录页加表单校验"
```

常用 CLI：`studio status`（健康检查）、`studio stop` / `studio restart`、`studio test`（API 冒烟）、`studio approve list`（待审批列表）。完整命令见 `./bin/studio` 不带参数运行。

开发模式：`pnpm dev:api` + `pnpm dev:web`（Vite 热更新，端口 5173）。

## 主干架构

主干链路（代码已全部存在，一期目标是修通而非重造）：

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

- **双向沟通**：agent 执行中遇到疑问/阻塞，以 `NEED_INPUT` 在频道向人提问并挂起；人在该线程回复后自动续跑。
- **REQ 需求编号**：一个需求（`REQ-<序号>`）= 一组 WorkUnit，首次 @mention 派发时自动分配；需求文档、SDD、产物以编号关联，UI 按编号串联全链路（见 vision §5.3）。
- **工程绑定**：WorkUnit 创建时绑定已注册工程（repo 路径 + git worktree 隔离），频道可设默认工程。
- **agent→agent 协作**：一期不做，二期再议。

数据存储全部走 FileStore（`~/.studio/`），无数据库依赖。

## 知识飞轮

闭环：`执行 → 提取 → 存储 → 注入 → 反馈 → 进化`。任务 COMPLETE 时自动做一次 LLM 提取（根因/模式/用户偏好），写入单一运行时知识库 `~/.studio/knowledge`，审核通过后才参与后续任务的注入（≤ 2K tokens/任务）。断点修复与推进顺序（先通数据 → 再度量 → 后进化）见 [docs/plans/2026-07-flywheel-repair.md](docs/plans/2026-07-flywheel-repair.md)。

## 文档地图

| 文档 | 作用 |
|------|------|
| `docs/vision-2026.md`（本地文档，gitignored 未入库） | 定位与主干设计共识（宪法），含三期演进路线 |
| [docs/plans/](docs/plans/) | 三期计划：一期 `2026-07-mvp-fix-plan.md`（修通最小闭环），二期 `2026-07-flywheel-repair.md`（飞轮通数据）+ `2026-07-cleanup-docs-ui.md`（清理） |
| [docs/sdd/](docs/sdd/) | 变更规格（SDD），按变更立项 |
| [CAPABILITIES.md](CAPABILITIES.md) | 能力清单（harness `sync-docs` 自动维护） |
| [AGENTS.md](AGENTS.md) | agent 导读与模块索引（纯机器维护，用 `pnpm agents-md:sync` 重建；手写 agent 指南在 CLAUDE.md） |

## License

MIT © dommaker
