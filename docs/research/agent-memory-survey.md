# 主流 agent 系统的长期记忆与上下文工程调研（issue #76）

> 研究票：issue #76（供「角色长期记忆机制」与「上下文组装与预算控制」两张决策票参照）。
> 调研日期 2026-08-09。本文为外部方案调研，只做对比与建议（options），不定案。
> 覆盖系统：Claude Code、Letta/MemGPT、Aider、Cline；方法论参考 Anthropic 上下文工程博客。

## 调研范围与方法

以一手来源为准：官方文档、官方工程博客、论文原文、开源代码。逐条结论均附来源 URL；无法从一手来源核实的标注「未核实」或略去。

**环境限制说明**：本次调研环境中 `code.claude.com` 与 `docs.claude.com` / `docs.anthropic.com` 均不可达（网络层失败）。Claude Code 相关事实改用以下途径交叉核实：

- `anthropics/claude-code` 官方 CHANGELOG（一手，Anthropic 自有仓库）：https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- 社区文档镜像 `claude-howto`（对官方文档的整理镜像，内容标注了对应的官方版本号）：https://github.com/luongnv89/claude-howto
- Anthropic 官方工程博客：https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

凡 Claude Code 小节中仅由镜像或二手来源支持的结论，正文单独注明；其余系统均直接核对了官方文档原文。

| 系统 | 一手来源 |
|------|---------|
| Claude Code | CHANGELOG（官方仓库）、claude-howto 镜像、Anthropic 工程博客 |
| Letta / MemGPT | MemGPT 论文（arXiv:2310.08560 全文）、docs.letta.com、letta.com 官方博客 |
| Aider | aider.chat 官方文档、`Aider-AI/aider` 源码 |
| Cline | docs.cline.bot、cline.bot 官方博客 |
| 方法论 | Anthropic《Effective context engineering for AI agents》 |

## 记忆分层模型

### Claude Code：文件分层 + 双轨记忆

Claude Code 有**两套互补的记忆系统**，都在每次会话启动时加载：CLAUDE.md 文件（人写的指令）与 auto memory（Claude 自己写的笔记）（[claude-howto 镜像 02-memory](https://github.com/luongnv89/claude-howto/blob/main/02-memory/README.md)）。

**CLAUDE.md 分层**（从宽到窄，加载顺序；多层是**拼接**进上下文，不是覆盖优先级）：

| 层级 | 位置 | 用途 |
|------|------|------|
| Managed policy | Linux: `/etc/claude-code/CLAUDE.md`；macOS: `/Library/Application Support/ClaudeCode/CLAUDE.md` | 组织级强制指令，个人设置无法排除 |
| User | `~/.claude/CLAUDE.md` | 个人偏好，跨项目 |
| Project | `./CLAUDE.md` 或 `./.claude/CLAUDE.md` | 团队共享，入版本库 |
| Local | `./CLAUDE.local.md` | 个人项目偏好，gitignore |

目录树上，Claude Code 从工作目录向上逐级加载；工作目录**之下**的子目录 CLAUDE.md 不在启动时加载，而是在 Claude 读到该子目录文件时**按需加载**。`.claude/rules/*.md` 是模块化的主题规则，可用 YAML frontmatter 的 `paths` 做路径作用域（命中时才加载）；用户级 rules 先于项目级加载（来源：同上镜像）。

**`@path` import 递归**：CLAUDE.md 支持 `@path/to/file` 引入外部文件，启动时随引用它的 CLAUDE.md 一并展开进上下文；相对/绝对路径均可，递归 import 有最大深度限制（镜像记为 4 hops）；代码块内的 `@` 不会被当作 import。注意官方仓库 issue 证实了一个实现差异：祖先目录 CLAUDE.md 里的 `@import` 不会被展开，只有 cwd 级 CLAUDE.md 的 import 生效（[anthropics/claude-code issue #79046](https://github.com/anthropics/claude-code/issues/79046)，引用了官方文档原文）。

**Auto memory（Claude 自写笔记）**：位于 `~/.claude/projects/<project>/memory/`，入口文件 `MEMORY.md` + 可选 topic 文件（如 `debugging.md`）。启动时只加载 `MEMORY.md` 的**前 200 行或前 25KB**（先到为准），topic 文件按需加载。同一 git 仓库的 worktree/子目录共享同一份 auto memory。v2.1.59+ 引入，默认开启，可用 `autoMemoryEnabled` / `CLAUDE_CODE_DISABLE_AUTO_MEMORY` 关闭（来源：claude-howto 镜像 02-memory；版本号与 CHANGELOG 中 memory 相关条目互证，如「Improved memory: the agent is now reminded to compact its `MEMORY.md` index when nearing the size limit」「Memory writes that leave a MEMORY.md index over its read limit now produce an explicit error instead of silent truncation」——[CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)）。

**Memory tool（API 侧）**：Anthropic 在 Sonnet 4.5 发布时于 Claude Developer Platform 推出 public beta 的 memory tool——基于文件系统的上下文外存取机制，让 agent 跨会话积累知识库（[Anthropic 工程博客](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）。它与 CLI 的 auto memory 同属「文件即记忆」路线。

**与分层相关的控制面**（均出自镜像 02-memory，官方页面本次不可达）：

- **子代理记忆作用域**：subagent 定义里可用 `memory` frontmatter 指定只加载 user / project / local 某一范围的记忆，让子代理带着收窄的上下文工作，而不是继承完整记忆层级。
- **monorepo 排除**：`claudeMdExcludes` 设置可按路径跳过无关的 CLAUDE.md，官方定位就是「减少上下文窗口里的噪声」；`--add-dir`（配合 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`）则反向支持加载额外目录的 CLAUDE.md。
- 另据一份对 Claude Code 源码的分析报告（二手来源），CLAUDE.md 内容是作为 **user 消息上下文**而非 system prompt 注入的，因此对模型的约束是概率性的，确定性约束由权限规则承担（[Claude Code Report（源码分析）](https://zhiqiangshen.com/projects/Claude_Code_Report/Claude_Code_Report.pdf)）。

### Letta / MemGPT：OS 式三层记忆 + 自编辑

**MemGPT 论文**（[arXiv:2310.08560](https://arxiv.org/abs/2310.08560)）提出「虚拟上下文管理」，类比 OS 的内存分层：

- **Main context（主上下文，类比 RAM）**= prompt tokens，分三段：system instructions（只读，含记忆层级说明与函数用法）、**working context**（定长可写块，存用户事实/偏好/persona，只能通过函数调用改写）、**FIFO queue**（滚动消息历史；队列头部第一条是已驱逐消息的**递归摘要**）。
- **External context（外部上下文，类比磁盘）**：**archival storage**（任意长度文本的读写库，存事实/文档）与 **recall storage**（完整对话历史库）。out-of-context 数据必须显式搬入 main context 才能参与推理。
- 记忆的编辑与检索**完全自指导（self-directed）**：LLM 通过函数调用自主决定何时在层级间搬数据；系统通过 token 上限警告（memory pressure warning）引导它的记忆管理决策；检索结果做分页防止单次调用打爆上下文。

**Letta（MemGPT 的产品化）** 把这套模型落为（[Letta 官方博客](https://www.letta.com/blog/agent-memory/)）：message buffer（最近消息，在上下文内）、**core memory = memory blocks**（钉在上下文里的可编辑块）、**recall memory**（完整对话历史，自动落盘，可搜索）、**archival memory**（显式存入的外部知识库，向量检索）。

**Memory blocks 的具体形态**（[Letta 文档：memory blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks)）：

- 块 = `label` + `description` + `value` + `limit`（**字符数上限**，文档示例中 persona/human 块默认 5000 字符）；以 `<memory_blocks>` XML 形式前置进 prompt，**始终可见、无需检索**。
- `description` 是 agent 判断「该块该写什么」的主要依据。
- 块默认可读写（agent 用内置记忆工具自编辑），可设 `read_only`；块可**跨 agent 共享**（多个 agent attach 同一块，一处更新处处可见）——官方明确把它定位成多 agent 协调原语。
- **Archival memory** 是语义可搜的向量库（[Letta 文档：archival memory](https://docs.letta.com/v1-sdk/memory/archival-memory/)）：agent 用 `archival_memory_insert` / `archival_memory_search` 工具交互，对 agent **不可变**（不能轻易改/删，开发者可走 SDK），无容量上限，支持 tag。官方明确区分：archival 是**有意**存储（agent 判断值得记的事实），conversation search（recall）是**历史**检索（原始消息，无需 agent 整理）。

另外，Letta 当前产品（Letta Code / Harness）已演进出 **MemFS——git 版本化的记忆文件系统**，agent 自己读写重组记忆文件，并支持 sleep-time subagent 在空闲期做记忆整理（[docs.letta.com llms.txt](https://docs.letta.com/llms.txt)）。这是「文件即记忆」路线在 Letta 侧的印证。

**Sleep-time compute（异步记忆整理）**（[Letta 官方博客](https://www.letta.com/blog/agent-memory/)）：相对论文里「记忆管理与对话挤在同一个 agent 主循环」的设计，sleep-time agent 把记忆管理挪到**异步**执行——不阻塞对话响应，且在空闲期主动重组、提炼记忆块，而不是对话中懒惰地增量追加。官方称这同时改善响应时延与记忆质量。blocks 文档还给出多 agent 协调示例：父 agent 可实时观察子 agent 的结果块更新，共享只读策略块可统一下发组织规范（[memory blocks 文档](https://docs.letta.com/v1-sdk/memory/memory-blocks)）。

### Aider：repo map 常驻 + 无跨会话持久记忆

Aider 没有传统意义的长期记忆；它的代表性做法是把**代码库结构本身**作为常驻上下文层（[aider 官方文档：repo map](https://aider.chat/docs/repomap.html)）：

- 每次用户请求都附带一份 **repo map**：全仓库文件清单 + 各文件关键符号（类/函数签名）的关键行。LLM 据此知道去哪里要完整文件（aider 再按需把文件加进会话）。
- 大仓库下对 repo map 做**图排序优化**：以源文件为节点、依赖关系为边构图排序，只把与当前会话最相关、能装进 token 预算的部分发给模型。
- 预算由 `--map-tokens` 控制，**默认 1k tokens**；aider 按会话状态动态调整，通常不超限，但没有文件入会话时会显著放大 map 以理解全仓（启动横幅会实际打印 `Repo-map: using 1024 tokens` 字样，见 [token-limits 文档](https://aider.chat/docs/troubleshooting/token-limits.html)）。

跨会话层面，aider 依赖 chat history 文件与 git commit，而非结构化记忆；上下文溢出的处理见后文（递归摘要）。值得注意 aider 的整体哲学是**把预算交给用户**：官方建议只把「需要编辑」的文件加进会话，用 `/tokens` 看用量、`/drop` 移除文件、`/clear` 清历史（[token-limits 文档](https://aider.chat/docs/troubleshooting/token-limits.html)）。

### Cline：规则文件 + Memory Bank 文档方法

Cline 的记忆是**纯文件/文档路线**，无内置记忆数据库：

- **规则层**（[Cline 文档：Cline Rules](https://docs.cline.bot/features/cline-rules)）：`.clinerules/` 目录下的 markdown（也自动识别 `.cursorrules`/`.windsurfrules`/`AGENTS.md`），工作区级 + 全局级（`~/Documents/Cline/Rules`），工作区优先；每条规则可单独开关；支持 YAML frontmatter `paths` 做**条件规则**（按消息提到的路径、打开的标签页、编辑过的文件激活），没有 frontmatter 的规则恒激活。官方明确提醒「规则消耗上下文 token，保持精简」。
- **Memory Bank**（[Cline 文档：Memory Bank](https://docs.cline.bot/best-practices/memory-bank)）：一套**文档方法论**而非功能——把 6 个核心 markdown（`projectbrief.md` / `productContext.md` / `activeContext.md` / `systemPatterns.md` / `techContext.md` / `progress.md`）放进仓库，通过 custom instructions 要求 Cline「每个任务开始必读全部 memory bank 文件」。`activeContext.md` 更新最频繁，`progress.md` 记录里程碑。官方 FAQ 明确它「是与 AI 无关的文档方法，任何能读文档的 AI 都能用」。
- Cline 自称「context engineering harness」：每轮组装指令、工具、环境细节、文件预览与历史（[cline.bot 上下文工程博客](https://cline.bot/blog/how-to-think-about-context-engineering-in-cline)）。
- **任务内的注意力管理**：Focus Chain（v3.25 起默认开）在任务开始时生成 todo list，并按固定节奏（默认每 6 条消息）重新注入上下文，防止长任务漂移；用户可直接编辑这份 markdown todo，Cline 会跟随调整（[上下文工程博客](https://cline.bot/blog/how-to-think-about-context-engineering-in-cline)）。
- **探索与执行分离**：`/deep-planning` 先静默调研代码库、追问澄清问题，产出 `implementation_plan.md`，然后**开一个新任务**引用该计划进入实现——把探索期的噪声挡在执行上下文之外（同上）。

## 写入时机与噪声控制

| 模式 | 代表 | 机制 | 噪声控制 |
|------|------|------|---------|
| 自动沉淀（agent 自写） | Claude Code auto memory | 会话中 Claude 自行把学到的模式/偏好写入 `MEMORY.md` 与 topic 文件 | 入口文件只加载前 200 行/25KB；索引接近上限时系统**提醒 agent 压缩 MEMORY.md**；写超限时显式报错而非静默截断（[CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)；镜像 02-memory） |
| 自动沉淀（agent 自编辑） | Letta / MemGPT | agent 通过 `core_memory_*` / `archival_memory_insert` 等工具自主决定记什么、改哪块；memory pressure 警告驱动「溢出前自救」 | 每块有字符上限；archival 对 agent 不可变（只能插不能改/删）；**sleep-time agent** 异步做记忆重组与提炼，把「记忆整理」从对话关键路径剥离（[Letta 博客](https://www.letta.com/blog/agent-memory/)、[archival 文档](https://docs.letta.com/v1-sdk/memory/archival-memory/)） |
| 人工审核 promote | Claude Code CLAUDE.md | 人写、人改（`/memory` 打开编辑器；`/init` 生成模板；对话中说「remember that...」由 Claude 写入对应文件——镜像 02-memory） | 人工即审核；分层隔离（组织/用户/项目/本地）控制影响面；项目级入 git，天然走 code review |
| 人工审核 promote | Cline Memory Bank | 「update memory bank」触发全量文档审查与更新，通常在里程碑/方向变化时手动执行 | 文件入仓库、随项目评审；FAQ 建议日常靠 Auto Compact，手动 update 留给重要检查点（[Memory Bank 文档](https://docs.cline.bot/best-practices/memory-bank)） |

观察：两条路线的噪声防线不同——自动沉淀靠**容量上限 + 超限提醒 + 异步整理**（sleep-time）兜底；人工审核靠**文件即 diff、git 即审计**。Anthropic 博客把结构化笔记（agent 写 NOTES.md 式文件、之后读回）定位为「最小开销的持久记忆」（[Anthropic 工程博客](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）。

## 读取/注入策略与预算控制

三种策略的光谱：

- **注入式（always-in-context）**：Claude Code 的 CLAUDE.md 多层拼接、Letta memory blocks（钉在上下文）、Aider repo map（每请求必带）、Cline 恒激活规则。
- **按需召回（just-in-time 检索）**：Letta 的 `archival_memory_search` / conversation search；Claude Code 用 glob/grep 现查文件；Cline 条件规则按路径命中才加载；Claude Code 子目录 CLAUDE.md 按需加载。
- **混合**：Anthropic 官方明确说 Claude Code 就是混合——「CLAUDE.md 直接前置进上下文，glob/grep 等原语让它 just-in-time 地导航环境取文件」，并建议多数场景「做能跑通的最简单方案」（[Anthropic 工程博客](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）。

**有明确数字的预算机制**：

| 系统 | 预算数字 | 来源 |
|------|---------|------|
| Claude Code | auto memory 入口只加载前 200 行 / 25KB；MEMORY.md 索引有读取上限，超限报错/提醒压缩 | [镜像 02-memory](https://github.com/luongnv89/claude-howto/blob/main/02-memory/README.md)、[CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) |
| Claude Code | auto-compact 约在上下文 ~95% 容量触发，可用 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 覆盖 | [镜像 04-subagents](https://github.com/luongnv89/claude-howto/blob/main/04-subagents/README.md)、[镜像 10-cli](https://github.com/luongnv89/claude-howto/blob/main/10-cli/README.md)（官方页面本次不可达，95% 数字**未经官方文档直接核实**，多个二手来源一致） |
| Letta | 每个 memory block 有字符 `limit`（文档示例默认 5000）；超限写入会收到报错反馈并调整 | [memory blocks 文档](https://docs.letta.com/v1-sdk/memory/memory-blocks)、[MemGPT 论文](https://arxiv.org/abs/2310.08560) |
| MemGPT | 论文示例：70% 窗口触发 memory pressure 警告；100% 触发 flush，驱逐约 50% 消息并生成递归摘要 | [arXiv:2310.08560 §2.2](https://arxiv.org/abs/2310.08560) |
| Aider | repo map 默认 `--map-tokens` 1k tokens，按会话状态动态伸缩 | [repomap 文档](https://aider.chat/docs/repomap.html) |
| Cline | 内部跟踪上下文用量百分比（`environment_details` 中可见）；Focus Chain 默认每 6 条消息重注入 todo list 防漂移 | [cline.new_task 博客](https://cline.bot/blog/unlocking-persistent-memory-how-clines-new_task-tool-eliminates-context-window-limitations)、[上下文工程博客](https://cline.bot/blog/how-to-think-about-context-engineering-in-cline) |

方法论层面，Anthropic 给出的总原则是「**找到能最大化目标结果的最小高信号 token 集合**」，因为 context rot 使长上下文的召回质量递减；注意力是有限预算，每个 token 都在消耗它（[Anthropic 工程博客](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）。

同一博客还给出两个与「注入预算」直接相关的工程判断：

- **渐进披露（progressive disclosure）**：agent 维护轻量标识符（文件路径、存储的查询、链接），运行时用工具按需把数据拉进上下文；文件命名、目录层级、时间戳本身就是高效的检索元数据——「做能跑通的最简单方案」，比预建复杂索引更稳。
- **子代理作为预算隔离**：子代理可以消耗数万 token 做探索，只把 1,000–2,000 token 的蒸馏摘要交还主代理；细节上下文隔离在子代理内，主代理保持高信号。这与 Claude Code 的 subagent 记忆作用域收窄（前文）是同一思路的两端。

## 上下文溢出处理

- **Claude Code**：auto-compact（近窗口上限自动摘要，阈值见上表）+ `/compact [instructions]` 手动压缩（可带关注点指令）（[镜像 01-slash-commands](https://github.com/luongnv89/claude-howto/blob/main/01-slash-commands/README.md)）。Anthropic 博客披露其 compaction 实现：把消息历史交给模型摘要，**保留架构决策、未解决 bug、实现细节，丢弃冗余工具输出**，压缩后附带**最近访问的 5 个文件**继续；并推荐最轻量的「tool result clearing」（清理历史深处的工具调用结果）作为最安全的 compaction（[Anthropic 工程博客](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）。CHANGELOG 另有佐证：「Compaction prompt now asks the model to preserve sensitive user instructions」「reactive compaction 首次摘要按溢出量定种子」等。
- **MemGPT / Letta**：queue manager 两段式——70% 警告（给 agent 自救窗口，把重要信息写入 working context / archival）→ 100% flush（驱逐约 50% 消息，与旧摘要合成**新的递归摘要**置于队列头部；被驱逐消息永久留在 recall storage 可函数检索）（[论文 §2.2](https://arxiv.org/abs/2310.08560)）。Letta 博客补充工程经验：**只驱逐一部分（如 70%）消息以保证连续性**；驱逐出的消息做递归摘要，越老的消息在摘要中权重越低（[Letta 博客](https://www.letta.com/blog/agent-memory/)）。letta 仓库另有 sliding_window compaction 模式（仅驱逐不摘要）的实现痕迹（[letta-ai/letta issue #3270](https://github.com/letta-ai/letta/issues/3270)）。
- **Aider**：chat history 超限时自动递归摘要（源码 [`aider/history.py`](https://github.com/Aider-AI/aider/blob/main/aider/history.py)）：默认预算 1024 tokens，保留尾部约一半预算的原文消息，头部交由模型摘要；摘要+尾部仍超限时递归再摘要（深度 ≤3）；repo map 本身也随会话状态伸缩。另注意 aider 官方立场：它**不强制** token 上限，只报告 API 报错，建议用户用 `/drop`、`/clear` 主动瘦身（[token-limits 文档](https://aider.chat/docs/troubleshooting/token-limits.html)）。
- **Cline**：Auto Compact 接近上限时生成综合摘要（保留技术细节、代码变更与决策）替换历史后继续；摘要用既有 prompt cache，成本接近一次普通工具调用；不支持摘要的模型回退到**规则式截断**；可用 checkpoints 回滚到摘要前的状态（[Auto Compact 文档](https://docs.cline.bot/features/auto-compact)）。配合机制：`/newtask` 开新任务并携带蒸馏后的上下文做跨窗口 handoff（[new_task 博客](https://cline.bot/blog/unlocking-persistent-memory-how-clines-new_task-tool-eliminates-context-window-limitations)）；Memory Bank 则把人工作为「溢出前存档」的一环（先 update memory bank 再开新会话）。

**横向规律**：四家的溢出处理收敛到同一个骨架——**近期原文保留 + 远期递归摘要 + 原始数据外置可检索**。差异只在触发点（Claude Code ~95% 阈值 vs MemGPT 70% 警告 + 100% flush 两段式）、摘要保真策略（保留什么：决策/代码变更/未决问题）与兜底（Cline 的截断回退、checkpoints 回滚；Aider 的不强制只报错）。Anthropic 对摘要器调优的建议是先最大化 recall（不漏任何相关信息）再迭代 precision（删冗余），并警告过度压缩会丢掉「事后才发现重要」的微妙上下文（[Anthropic 工程博客](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）。

## 对比表

| 系统 | 记忆分层 | 写入时机与审核 | 读取注入策略 | 预算控制 | 溢出处理 | 主要来源 |
|------|---------|---------------|-------------|---------|---------|---------|
| Claude Code | CLAUDE.md 四层（managed/user/project/local）拼接 + `.claude/rules` 路径规则 + auto memory（MEMORY.md + topic 文件） | 双轨：人写 CLAUDE.md（git 评审）；Claude 自写 auto memory（默认开） | 混合：启动全量注入 + 子目录/规则按需加载 + glob/grep 现查 | MEMORY.md 只载前 200 行/25KB；索引超限提醒压缩 | auto-compact（~95%，镜像来源）+ `/compact`；保留决策/丢弃工具输出 + 最近 5 文件 | [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)、[镜像 02-memory](https://github.com/luongnv89/claude-howto/blob/main/02-memory/README.md)、[Anthropic 博客](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) |
| Letta / MemGPT | main context（system/working context/FIFO queue）vs external（archival/recall）；Letta 落地为 memory blocks + 向量库 | agent 自编辑（工具调用）；块可 read_only、可跨 agent 共享；sleep-time 异步整理 | 混合：blocks 钉在上下文；archival/recall 工具检索，分页返回 | 每块字符 limit（示例 5000）；论文示例 70% 警告线 | 100% flush 驱逐 ~50% + 递归摘要；建议只驱逐部分（如 70%）保连续性 | [论文](https://arxiv.org/abs/2310.08560)、[blocks 文档](https://docs.letta.com/v1-sdk/memory/memory-blocks)、[archival 文档](https://docs.letta.com/v1-sdk/memory/archival-memory/)、[Letta 博客](https://www.letta.com/blog/agent-memory/) |
| Aider | 无持久记忆层；repo map 作为常驻结构上下文 + chat history 文件 | 不适用（不写记忆；历史随会话累积） | 注入式：repo map 每请求必带；完整文件按需加入会话 | repo map 默认 1k tokens（`--map-tokens`），图排序裁剪 | chat history 递归摘要（1024 token 预算、深度≤3）；不强制上限只报错 | [repomap](https://aider.chat/docs/repomap.html)、[history.py](https://github.com/Aider-AI/aider/blob/main/aider/history.py)、[token-limits](https://aider.chat/docs/troubleshooting/token-limits.html) |
| Cline | `.clinerules/` 规则（工作区/全局、条件激活）+ Memory Bank 6 文件文档层 | 人写规则/memory bank（入 git）；agent 可被指令更新 memory bank | 混合：恒激活规则全量注入；条件规则按路径命中；memory bank 每任务开头全读 | 官方提醒规则耗 token 需精简；内部跟踪上下文用量百分比 | Auto Compact 摘要替换历史；不支持的模型回退截断；checkpoints 可回滚；`/newtask` 跨窗口 handoff | [Rules](https://docs.cline.bot/features/cline-rules)、[Memory Bank](https://docs.cline.bot/best-practices/memory-bank)、[Auto Compact](https://docs.cline.bot/features/auto-compact) |

## 对 studio 场景的适配建议

以下均为**候选方案（options）与权衡**，供「角色长期记忆机制」「上下文组装与预算控制」两票选用，非结论。

studio 的关键约束决定了取舍方向：每步起**全新 CLI 子进程**（会话内的记忆工具状态带不走，**记忆必须落在文件/prompt 里**）；session resume 生产上不可靠（**每步都要从持久存储重新组装上下文**）；角色是轻量 persona 字符串；已有 markdown 知识库 `~/.studio/knowledge/`。好消息是：被调研的四家里有三家（Claude Code、Aider、Cline）的本质都是「文件即记忆」，与 studio 的文件系统现实天然兼容；Letta 的运行时钉块模式不可直接照搬，但其**块的抽象**（label/description/limit/共享）可以借鉴到文件层面。

**建议 1：角色长期记忆采用「MEMORY.md 索引 + topic 文件」的文件形态（Claude Code auto memory 模式），写入时机二选一或分层混合**

- 形态：每角色一份 `MEMORY.md`（索引，注入时只取前 N 行/固定 token 上限）+ 若干 topic 文件（按需读）。这直接复用 Claude Code 已验证的加载语义（索引截断加载防膨胀），也兼容现有 `~/.studio/knowledge/` markdown 存储。
- 写入选项 A（自动沉淀）：步末由 agent 自写记忆文件，平台侧配两条防线——索引接近上限时在下一步 prompt 提醒 agent 压缩（Claude Code 的做法），写超限时显式报错。代价：噪声与自引风险，需要 limit 兜底。
- 写入选项 B（人工 promote）：agent 只写「候选记忆」区，经频道确认后落正式区。代价：多一步人审，沉淀率低。
- 折中：低置信/过程性笔记自动写（带 limit），角色定义性事实走人工 promote——对应 Letta 里 core block 可读写 vs read_only 的区分。

**建议 2：上下文组装采用混合策略 + 分段 token 预算（Aider `--map-tokens` 思路）**

- 给每步 prompt 的分段各设预算：persona（小）、角色记忆索引（如 ≤500–1000 tokens）、知识库召回（如 ≤1–2k tokens，对应 aider repo map 的默认量级）、任务状态/打回 hint、人类新回复。预算内装不下时按优先级裁剪（人类回复 > 打回 hint > 记忆索引 > 知识召回），而不是整体截断。
- 注入 vs 召回：只注入**索引/摘要级**内容；因为每步都是有文件工具的 CLI 子进程，知识库正文可以靠 grep/读文件 just-in-time 获取（Anthropic 博客的混合模式，也正是 Claude Code 的做法）。纯注入式（每步全量知识库）在知识库增长后必然失控；纯召回式对「一步一进程、无探索余量」的短步又太冒险——索引注入 + 按需展开是中间解。
- 可借鉴 Cline 条件规则：知识/规则文件带路径或标签 frontmatter，按当前 WU 涉及的模块命中才注入，降低无关噪声。

**建议 3：跨步连续性用「结构化笔记 + 递归摘要」补齐（MemGPT FIFO + Anthropic note-taking 模式）**

- 现状（据 issue #71 调研）：PROGRESS 步摘要只发频道、不落 metadata、不进 prompt，session resume 又不可靠——跨步上下文基本靠任务原文 + 人类回复。
- 选项：每步结束把结构化步摘要（结论/改动文件/未决问题）落盘；下一步注入最近 K 条原文摘要，更旧的合并成一份**递归摘要**（MemGPT 队列头部的 recursive summary 同款）；被合并的原文保留在存储里供按需检索。这正是 Anthropic 博客说的「structured note-taking：最小开销的持久记忆」。
- 权衡：摘要是有损压缩，MemGPT/Letta 的经验是**只压缩旧段、保留近期原文**（Letta 建议驱逐不超过 ~70%），且摘要 prompt 要先保 recall 再调 precision（Anthropic 博客）。

**建议 4：persona 字符串升级为「带 limit 的 persona 块」，团队规范做成共享只读块（Letta block 抽象的文件版）**

- 角色 persona 目前是自由字符串，无容量约束、无结构。可定义 `label + description + value + 字符上限` 的角色块文件：`description` 告诉 agent 该块用途（Letta 文档强调 description 是 agent 正确使用块的关键），limit 防止 persona 膨胀挤占预算。
- 跨角色共享的规范（工程铁律、输出契约）做成**共享只读块**——对应 Letta shared blocks「一处更新、处处可见」与 read_only 防 agent 破坏的组合；文件版实现即 `~/.studio/knowledge/` 下的公共文件以只读语义注入。

未决问题（留待决策票）：记忆文件的并发写冲突（多 WU 同角色并行）、噪声的量化评估方式、预算数字的初值标定。

## 参考来源

Claude Code / Anthropic：

- https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://code.claude.com/docs/en/memory （官方文档规范地址；**本次环境不可达**，内容经下列镜像与 CHANGELOG 交叉核实）
- https://github.com/luongnv89/claude-howto/blob/main/02-memory/README.md
- https://github.com/luongnv89/claude-howto/blob/main/01-slash-commands/README.md
- https://github.com/luongnv89/claude-howto/blob/main/04-subagents/README.md
- https://github.com/luongnv89/claude-howto/blob/main/10-cli/README.md
- https://github.com/anthropics/claude-code/issues/79046

Letta / MemGPT：

- https://arxiv.org/abs/2310.08560
- https://docs.letta.com/v1-sdk/memory/memory-blocks
- https://docs.letta.com/v1-sdk/memory/archival-memory/
- https://www.letta.com/blog/agent-memory/
- https://docs.letta.com/llms.txt
- https://github.com/letta-ai/letta/issues/3270

Aider：

- https://aider.chat/docs/repomap.html
- https://aider.chat/docs/troubleshooting/token-limits.html
- https://github.com/Aider-AI/aider/blob/main/aider/history.py

Cline：

- https://docs.cline.bot/best-practices/memory-bank
- https://docs.cline.bot/features/cline-rules
- https://docs.cline.bot/features/auto-compact
- https://cline.bot/blog/how-to-think-about-context-engineering-in-cline
- https://cline.bot/blog/unlocking-persistent-memory-how-clines-new_task-tool-eliminates-context-window-limitations
