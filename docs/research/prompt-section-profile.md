# prompt 各段实际占用画像（issue #77）

> 研究票：issue #77（地图票 #74 的子票）。调研日期 2026-08-09。
> 代码侧以 `apps/api/src` 为准；数据侧只读生产数据
> （`/root/.claude/projects/` 的 claude 会话 transcript、`~/.studio/logs/studio-events.jsonl`、
> `~/.studio/data/workunits/index.json`、落盘的 `<worktree>/.daemon/prompt.md`）。
> transcript 只做结构化统计，未引用对话正文。只测量，不定案。

## 数据源与方法

| 数据源 | 路径 | 体量 / 口径 |
|--------|------|------|
| prompt 组装代码 | `apps/api/src/modules/agents/loop/prompt-composer.ts`（`composeStepPrompt` :75-183、`INJECT_TOKEN_BUDGET = 2_000` :33）、`apps/api/src/modules/agents/loop/agent-loop-parsers.ts`（base prompt :190-221）、`packages/studio-agent/src/services/runner-params.ts:266-270`（knowledgeContext + base 拼接）、`apps/api/src/modules/knowledge/knowledge-service.ts:580-599`（trim 事件） | 全量精读 |
| 步 prompt 语料 | `/root/.claude/projects/-root-projects-studio/*.jsonl` | **91 个真实执行步 prompt**（2026-07-31 ~ 08-09 窗口），行首锚定 `## 当前工作` 识别 |
| 落盘 prompt | `/root/projects/studio/.daemon/prompt.md` | 1 份活样本（2026-08-09 17:03，dev 进程在跑 WU），4,447 字符，版式与 transcript 语料逐段一致，互证口径可靠 |
| trim 事件 | `~/.studio/logs/studio-events.jsonl` | 10,831 行（2026-08-02 ~ 08-09），`knowledge:inject-trimmed` **0 条** |
| WU 索引 | `~/.studio/data/workunits/index.json` | 150 WU；仅 3 个 metadata 含 `worktreePath` 且目录已拆除 |

**token 估算口径：TokenEstimator.estimateText**（@dommaker/harness 现役口径，`prompt-composer.ts` 与 `knowledge-service.ts` 统一使用）。**下文 token 数均为 2026-08-09 迁移前 chars/4 口径实测的历史快照**（CJK 段与现役口径有差，仅供历史参考）。

**分段口径**：最终 prompt = `[knowledgeContext]\n\n---\n\n[basePrompt]`（`runner-params.ts:266-270`）。按代码里的固定字面标题锚定切分：`## 本次任务 Skills`（skills 索引）→ `## 你的角色`（persona）→ `## 频道成员与委派`（roster + 委派协议）→ `## 项目上下文`（知识包装，内容为空壳）→ `## 系统约束` / `## 上下文` / `## 近期信号`（知识注入正文）→ `[知识库: N 条参考…]` 行 → `## 何时查知识库` → `---` → `## 当前工作`（wu.scope）→ `## 人类新回复`（若有）→ `## 要求`（ACTION 协议）→ `## 提交提醒` / `## 验证失败` / `## 子任务提醒`（guard-hint，若有）。知识条目正文里嵌套的 `## 问题` 等标题不属于顶层分段，已按锚定标题规避。

**语料构成警告（重要）**：91 个步 prompt 几乎全是触发器维护型 WU——`tree-tokens test` 测试 scope 52 个（57%）、系统健康巡检 11、知识质量/沉淀/提取扫描 21，真实产品需求 WU 仅 `分析需求 PMO-12` 3 个。且全部命中 `-root-projects-studio` 目录（dev API 进程的 cwd），prod 进程的步 prompt 不在 `~/.claude/projects` 语料内。下文分布代表**维护型负载**的画像；大 scope、多成员委派、人类回复、guard-hint 等场景在窗口内样本稀少或为零。事件流为 dev/prod 两进程混写（与 #74 Notes 记录一致）。

---

## 问题 1：各段 token 占用分布（n=91，单位：token，chars/4）

| 段 | 命中 n | p50 | p90 | max | 备注 |
|------|-------|-----|-----|-----|------|
| skills 索引（`## 本次任务 Skills`） | 91 | 580 | 580 | 580 | 12 个内容变体；无截断签名 |
| persona（`## 你的角色`） | 59 | 9 | 9 | 12 | 单行角色描述，32 个 prompt 无此段 |
| 频道成员与委派（`## 频道成员与委派`） | 14 | 125 | 125 | 125 | 仅频道型 WU 有；含 DELEGATE 协议段 |
| **知识注入合计** | 91 | **183** | **200** | **203** | 下列 4 个子段之和 |
| — `## 系统约束` / `## 上下文` | **0** | — | — | — | 窗口内从未出现（佐证 #74 Notes：rule/context 注入永久为空的 `sourceReferences` bug） |
| — `## 近期信号` | 91 | 136 | 153 | 156 | 知识注入的实际内容全部在此 |
| — `[知识库: N 条参考]` 行 | 91 | 6 | 6 | 6 | N ∈ [28, 36] |
| — `## 何时查知识库` | 91 | 41 | 41 | 41 | 固定引导文案 |
| wu.scope（`## 当前工作` 正文） | 91 | 5 | 51 | 122 | p50 仅 ~20 字符（维护型 scope 极短，如「系统健康巡检」6 字符） |
| 人类回复（`## 人类新回复`） | **0** | — | — | — | reply 变体 base prompt 在窗口内零样本 |
| ACTION 协议（`## 要求`） | 91 | 84 | 84 | 84 | 固定文案，逐字恒定 |
| guard-hint ×3（提交/验证/子任务提醒） | **0** | — | — | — | 窗口内零样本（WU 索引历史上仅 1 个 `commitGuardHint` 记录） |
| **整份步 prompt** | 91 | **884** | **973** | **1,112** | |

解读：

- **整份组装 prompt 只有 ~0.9K token**（p50 884 / p90 973 / max 1,112）。对照 #71 实测的每步 CLI input p50=27.2K，**prompt-composer 组装的内容只占 ~3%**；其余 ~26K 是 CLI 脚手架（系统 prompt、工具/MCP schema、AGENTS.md/CLAUDE.md 等），完全不在 `INJECT_TOKEN_BUDGET` 的管辖范围内。若 #74 的「预算控制」决策只盯着 2K 注入预算，管控的是每步 input 的零头。
- **skills 索引是最大单一固定开销**：恒定 580 token，占 p50 prompt 的 66%。91 个 prompt 仅 12 个内容变体，且同一 WU 类型的每个步都全量重复（与 #71「每步全新 CLI 会话、续用零样本」叠加：这份索引逐步重付）。
- 知识注入的有效内容只有 `近期信号` 一段（p50 136 token）；`系统约束`/`上下文` 两个子段在窗口内**从未出现**，与 #74 Notes 已记录的 `sourceReferences` 过滤 bug 互相印证——即该 bug 修复后注入段会膨胀，当前分布是「带病」基线。
- wu.scope p50 仅 5 token，但这是语料偏维护型 WU 所致，不代表产品型任务（PMO-12 样本 scope ~122 token）。

## 问题 2：2K 共享注入预算的命中率与截断频率

预算口径：`INJECT_TOKEN_BUDGET = 2_000`（`prompt-composer.ts:33`），skills → persona → roster → knowledge 四段按优先级共享，前序花剩多少后序用多少。

实测四段合计（injectΣ）：

| 指标 | 值 |
|------|-----|
| injectΣ p50 / p90 / max | 772 / 869 / 907 token |
| 命中率（injectΣ ≥ 2,000） | **0 / 91（0%）** |
| 最高预算利用率 | 907 / 2,000 ≈ **45%** |
| `knowledge:inject-trimmed` 事件 | **0 条**（事件流 08-02 ~ 08-09 全量 10,831 行；其余日志文件也为 0） |
| skills 段截断签名（末块缺 `全文：` 行） | **0 / 91** |
| persona / roster 硬切签名 | 未观测到（各段最大值距预算尚远，无从触发） |

结论：**窗口内 2K 预算从未命中，任何一段的截断路径都从未在生产真实触发**——skills 整块丢弃/首块硬切、persona/roster 的 `.slice()` 硬切、knowledge 的 per-item skip 全是未执行过的代码路径（与 #74 Notes「截断保护是死代码」一致）。另注意 `knowledge:inject-trimmed` 事件只覆盖 knowledge 段的截断，payload 只有 entry id 列表（`trimmedIds`/`trimmedCount`），无分段字段、无原始/截后尺寸；skills/persona/roster 被截时**不发任何事件**，即使将来触发也只能从 prompt 文本签名观测。

## 问题 3：有效信息密度——多少 token 花在「重复看懂任务」上

把 prompt 内容分为两类：**任务独有信息**（wu.scope + persona + 人类回复 + guard-hint——agent 不注入就不知道的东西）与**上下文重建**（skills 索引 + 知识注入 + ACTION 协议等固定/半固定样板——每个步、每个会话都要重讲一遍的东西）。

| 指标 | 值（n=91） |
|------|-----------|
| 任务独有信息（scope+persona）p50 / p90 / max | **14** / 60 / 122 token |
| 占整份 prompt 比例 p50 / p90 / max | **1.6%** / 6.7% / 11.0% |
| 上下文重建 p50 构成 | skills 索引 580（66%）+ 知识注入 183（21%）+ 协议/hint 样板 131（15%） |

即在 p50 上，**每份步 prompt 约 98% 的 token 用于重新建立上下文，只有 ~14 个 token（1.6%）是任务独有信息**。与 #71 的结论对接：

- #71 证实生产上**每个执行步都跑在全新 CLI 会话**（续用零样本），且重组 prompt 里没有任何进展信息（无 handoff 段——本测量语料中也不存在任何「前序进展」类段落，guard-hint 与人类回复两个一次性注入段在窗口内 n=0）。
- 因此这份 98% 的重建开销是**逐步重付**的：一个 16 步的 WU 要为 skills 索引付 16 × 580 ≈ 9.3K token、为固定样板付 16 × 131 ≈ 2.1K token。
- 但放回 #71 的总量尺度看：每步 CLI input p50=27.2K 中，组装 prompt 仅 ~0.9K（3%）。**「重复看懂任务」的大头不在 prompt-composer 管辖的段里，而在 CLI 脚手架的 ~26K 逐层重读**（系统 prompt/工具 schema/AGENTS.md 等随首步全量进入，且无缓存命中——#71 实测首步 `cacheWrite` 恒 0）。prompt 侧的预算决策能省的是零头；零进展信息导致的「重看现场」（worktree 探索、git log、重读 SDD）以 tool-call 轮次计价，不在本口径内，需按 #71 §2.3 的案例法另估。

---

## 附：分段语法可靠性备忘（给后续测量复用）

- 除 `## 当前工作` / `## 要求` 外每个 `##` 标题都可能缺省（空段/预算饿死时不输出）；`## 项目上下文` 标题后仅单个 `\n`；knowledgeContext 为空时无 `---` 分隔线；A1–A3 全空时知识文本以**无标题**形式出现在文件顶。
- persona/roster 的 `.slice()` 硬切可断在行中，roster 被切时可能连带丢失 DELEGATE 协议段；skills 截断表现为整块缺失或首块无 `全文：` 行。
- `wu.scope` 原文插值，若 scope 内含行首 `## ` 会产生伪标题（本语料中分析型 WU 的 `## 工作方式约束` / `## 输出约定` 即为 scope 内嵌内容，非组装段）。
- 指纹识别步 prompt 须**行首锚定** `^## 当前工作$`：子串匹配会误中内嵌 transcript 的评审类 prompt（本窗口有 1 例 217K 字符的误判样本）。

## 遗留问题（仅记录，未建票）

1. **测试 scope 污染**：`tree-tokens test` 占语料 57%（52/91），与 #68 已记录的 `wu-cumul` 测试 id 污染同类——测试 WU 与生产 WU 的语料/事件隔离是否需要机制保障？
2. **prod 进程语料缺口**：本测量全部样本来自 dev 进程 cwd；prod 的步 prompt transcript 落在哪（worktree 拆除后是否可考）未定位，dev/prod 画像可能不同。
3. **预算余量 vs 注入稀薄**：45% 的利用率上限是因为预算宽松，还是因为知识库 rule/context 注入 bug 导致注入段过薄？修 `sourceReferences` bug 后注入段会膨胀多少、2K 是否仍够，需修复后重测。
4. **skills 索引 580 token 恒定占 66%**：12 个变体说明选择器基本按 WU 类型返回固定全集，是否有按 wuType 预裁剪的空间，留待 #74 预算分配决策。
5. **trim 可观测性**：即使将来触发截断，skills/persona/roster 三段无事件、无日志，只能事后从 prompt 签名推断；`knowledge:inject-trimmed` 的 payload 也无分段/尺寸字段，作数据源前需先补埋点。
