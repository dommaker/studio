# Agent 文档落点模型：生效范围决定载体，AGENTS.md 公共面正本 + CLAUDE.md 本机薄身（2026-08-21）

> 状态：**active**（2026-08-21 决策单 [#300](https://github.com/dommaker/studio/issues/300) 冻结）。来源：grilling 三轮开图（Q1-Q11 全裁决）+ 工具读取行为实证调研（本机二进制验证）。
> 前置 ADR：[2026-08-21-agent-docs-three-kinds.md](./2026-08-21-agent-docs-three-kinds.md)（内容三分与术语）。

## 决策

三载体各装且只装一类内容，零重复：

| 载体 | 性质 | 内容 |
|------|------|------|
| `AGENTS.md`（入库） | 公共面 | 项目说明书（机器生成段，现状不动）+ 治理契约（手写 PRESERVE 段，从 CLAUDE.md 迁入） |
| `CLAUDE.md`（gitignored） | 本机面 | 薄真身：首行 `@AGENTS.md` 导入全量公共面 + 本机运维簿（发布铁律摘要 + 指针 → 私有仓 `studio-config/SHIP.md` 唯一正本；路径/日志/回滚细节不留副本） |
| 各源码目录 `CONTEXT.md` | 跟代码走 | 模块知识（散置模型不变） |

配套落点：

- **ADR 家 = `docs/adr/`**（本目录，由 `docs/decisions/` 改名而来）：决策记录是工单无关的永久导航件——决策单关闭后依然约束未来决策者，过不了「工单绑定产物」判别（随工单生灭归档），故不落 `.studio/`。`.studio/` 收缩为纯工单绑定产物（`specs/`、`research/`）。
- **已公开运维内容处置 = 只止血**：AGENTS.md `PRESERVE:release-flow` 段摘除；GitHub 历史不重写（内容分级 = 内部拓扑级，无凭证；重写公共仓历史代价与收益不匹配）。
- 父目录 `/root/projects` 布局不动（非 git 仓、无公开面，AGENTS.md → CLAUDE.md 软链各对各的生效范围）。

## 依据：工具读取矩阵（2026-08-21 本机实证）

| 工具 | 自动读取 |
|------|----------|
| Claude Code | 仅 `CLAUDE.md`（含 `@import`；**至今任何版本不读 AGENTS.md**，官方 workaround = `@AGENTS.md` 导入或软链） |
| Codex / Cursor / Kimi | `AGENTS.md`（Kimi 跟随软链） |
| Qoder | `AGENTS.md` + `AGENTS.local.md`（本机覆盖层），不读 CLAUDE.md |
| Gemini | `GEMINI.md`（本环境不用，忽略） |

推论：薄身方案取 `@AGENTS.md` 导入（官方 workaround），不取软链——软链把本机运维簿逼出仓库，违背「本机内容住仓内 gitignore 文件」。非 Claude 工具看不到本机运维簿是**可接受缺口**：发布铁律的可公开部分已随治理契约进 AGENTS.md，路径/日志细节对不在本机的 agent 本就无效；不为一段指针引入 AGENTS.local.md 第二本机文件。

## 翻案记录

- **2026-07「AGENTS.md 无手写」裁决翻案**（原方案见 `docs/plans/2026-07-agents-md-governance.md`）：该裁决优化的是生成器所有权，牺牲的是读者完整性。治理是每次会话的前提约束而非参考资料，必须在进场首读文件全文可见；独立 `docs/governance.md` + 指针方案（每 agent 多一跳）否决。
- **`.studio/adr/` 约定废止**：原 CLAUDE.md 工单类型表与根 CONTEXT.md「三层存储」词条中的 `.studio/adr/` 引用已改指 `docs/adr/`（本次改名同步完成）；library 模块聚合面（`.studio/adr/` 读取与测试 fixture）的适配留待实施工单。
- **harness 适配**：`sync-docs` 生成目标与 PRESERVE 语义、`init` 的 HARNESS_CONSTRAINTS 写入目标，均须适配「AGENTS.md 正本 + CLAUDE.md 薄身」——留待 harness 改造工单。

## 迁移

决策单冻结后开 map 拆实施工单（预估 4-6 张）：harness 改造 / studio 内容迁移（治理入 AGENTS.md、CLAUDE.md 薄身化、摘除 release-flow 段）/ skills 同步 / 泄露止血 / 词表与指针清理（根 CONTEXT.md 增「工单绑定产物」「生效范围」「入口文档三分」词条，「票」→「工单」）。
