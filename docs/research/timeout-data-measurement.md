# 步时长与静默间隔分布测量（issue #68）

> 研究票：issue #68（地图 #53 子票，阻塞 #54 超时策略决策）。测量日期 2026-08-09。
> 全程只读生产数据；transcript 只做时间戳/统计层面分析，未引用对话正文。

## 数据源与方法

| 数据源 | 路径 | 体量 |
|--------|------|------|
| WU 索引 | `~/.studio/data/workunits/index.json` | 150 WU（2026-07-13 ~ 08-09） |
| 业务事件流 | `~/.studio/logs/studio-events.jsonl` | 15,836 行（近 7 天） |
| claude 会话 transcript | `/root/.claude/projects/<cwd-slug>/<sessionId>.jsonl`（agent 继承 `HOME=/root`，见 `runner-params.ts: buildSessionEnv`） | 候选目录约 130MB / 1,955 个会话文件 |
| kimi 会话数据 | `/root/.kimi-code/sessions/wd_*/session_*/agents/main/wire.jsonl`（kimi CLI 自有落盘，cwd 维度分桶） | 5 个 cwd 桶、62 个主会话 |
| 知识引擎沉淀会话 | `~/.studio/data/sessions/*.jsonl.done`（claude transcript 格式沉积） | 19 个文件 / 143MB |

**关键事实（决定样本口径）**：

- 生产 agent 全部 7 个 active profile 的 `provider` 均为 **claude**（`~/.studio/data/agents/*/profile.json`）。**kimi/opencode/codex 在 agent-loop 生产执行中零使用**，本地 kimi 会话全部是交互式会话（workDir=`/root/projects`），只能作参考样本，不代表生产步。
- studio 步会话用 prompt 头指纹 `## 本次任务 Skills`（prompt-composer 注入）识别，1,955 个 claude 会话中命中 **106 个**。
- 步边界 = transcript 中真实 prompt（user/string 行）；步内相邻事件时间戳差 = 静默间隔。
- 被 120s 超杀（WU metadata `errorDetail="Command timed out after 2min"`，来自 `agent-loop.ts:703 timeoutMs: 120_000`）的步通过"会话与失败 WU 活跃窗口重叠"隔离，**不并入健康分布**。

## 1. 步时长分布（墙钟，开始→结束）

| 样本 | n | p50 | p90 | p99 | max |
|------|---|-----|-----|-----|-----|
| 健康步（claude，未触碰任何失败 WU 窗口） | 38 | **54.2s** | **127.7s** | **693.2s** | **763.8s** |
| 其中 sessionId 精确匹配子样本（多为 tree-tokens 测试 WU） | 21 | 54.2s | 88.0s | 91.0s | 91.5s |
| 被 120s 超杀的步（失败窗口内） | 106 | 120.0s（被杀点） | — | — | — |
| 超杀步 transcript 全长（含孤儿尾部，见 §4） | 106 | 144.5s | 1,284.4s | 2,311.9s | 3,071.2s |

注：健康样本中有 693~764s 的长步存活——它们走的是非 agent-loop 路径（`runner-lightweight` 默认 `timeoutMs=30min`，`runner-execution.ts:254`），说明**超过 120s 的执行在本系统是常态需求**，120s 硬顶只砍 agent-loop WU 步。

## 2. 静默间隔分布（步内相邻输出事件间隔）

| 样本 | n（间隔数） | p50 | p90 | p99 | max |
|------|---|-----|-----|-----|-----|
| **健康步（claude studio 步）** | 1,189（38 步） | 0.5s | 5.6s | **33.0s** | 304.9s |
| 健康步的**步内最大间隔**（看门狗定档依据） | 38 | 16.8s | 47.0s | **214.7s** | **304.9s** |
| 知识引擎沉淀 transcript（claude，6~7 月历史会话） | 43,691（19 文件） | 0.6s | 8.2s | **126.5s** | 3,327.8s |
| kimi 交互式会话（参考，非生产步） | 65,431（62 会话） | ~0s | 12.4s | **115.1s** | 3,553.1s |
| 被超杀步（含孤儿尾部，仅供参考不定档） | 2,402（106 步） | 0.4s | 10.8s | 125.1s | 389.7s |

大间隔成因抽查（top 8 健康大间隔）：全部是**长 Bash 工具调用**（assistant tool_use → tool_result 之间无 transcript 事件）或长 LLM 生成（assistant 行在完成时才落盘）。即 **>120s、甚至 >200s 的静默在健康执行中真实存在**——纯静默看门狗阈值若定 120s 会误杀健康步。

## 3. PMO-12 事故案例单独分析

WU `3a86c8c0-0eda-4c19-b5c9-a9fafe697740`（scope「分析需求 PMO-12…」，2026-08-09 08:59 创建，3 步后 blocked）。3 个步各有独立 transcript（每步失败都会重置 sessionId，见 `agent-loop.ts` `resetUnestablishedSession`），tokens 事件给出精确杀点：

| 步 | transcript | 开始 | 被杀（tokens 事件） | 杀前最后事件 | 杀前最大静默 | transcript 实际写到 |
|----|-----------|------|------|------|------|------|
| 1 | `d31fc56f…` | 08:59:29 | 09:01:24（+115s） | 杀前 16.9s | 37.5s | 09:01:55（+146s） |
| 2 | `3643099d…` | 09:01:44 | 09:03:40（+116s） | 杀前 24.4s | 82.2s | 09:07:11（+326s） |
| 3 | `626508fe…` | 09:04:00 | 09:05:56（+116s） | 杀前 14.8s | 44.8s | 09:07:22（+202s） |

结论：**典型的"健康但被误杀"**——三步被杀前都在持续产出事件（最后事件距杀点仅 15~24s，杀前最大静默 ≤82s，远低于任何合理看门狗线），只是任务需要 2.5~5.5 分钟而硬顶是 120s。

## 4. 附带发现：SIGTERM 杀不死 CLI（孤儿进程）

`process-io.ts:121` 超时后 `child.kill('SIGTERM')`，但 PMO-12 及失败窗口样本显示 transcript 在"被杀"后继续写入 26s ~ 36 分钟（p50 144.5s、p90 1,284s）。即 SIGTERM 只杀死了直接子进程（shell 包装）或被 CLI 忽略，**CLI 孙进程孤儿化继续烧 token**。这放大了误杀的成本：WU 被判失败重试，旧 CLI 还在跑，同任务双重执行。建议 #54 一并处理（进程组杀死 / SIGKILL 兜底 / 杀后校验）。

## 5. 阈值建议（供 #54）

基于：健康步时长 p99=693s（n=38）；健康步内最大静默 p99=214.7s、观测极值 305s（长 Bash 调用）；沉淀/交互样本印证 >120s 静默常见（p99 分别为 126.5s / 115.1s）。

| 参数 | 现状 | 建议 | 理由 |
|------|------|------|------|
| 步墙钟超时 | 120s 硬顶（`agent-loop.ts:703`） | **1,800s（30min）**，与 runner 默认值对齐 | 健康 p99=693s，120s 连 p50~p90 之间都砍；1,800 ≈ p99×2.6 安全系数。墙钟只做最后兜底，卡死检测交给静默看门狗 |
| 静默看门狗阈值 | 无 | **600s** 触发杀步；**300s** 先记 warn 事件 | 健康步内最大静默 p99=214.7s、观测 max=305s；600s ≈ p99+2.8× 且 >2× 观测极值；300s 预警留观测数据供后续收紧 |
| WU 租约心跳间隔 | timeoutAt 仅 claim 时写一次（#58-H1） | **心跳 30s 一次；连续 10 次（5min）无心跳才 timeout-release** | 心跳须 ≪ 释放阈值以区分"loop 活着但步慢"与"loop 死了"；5min 释放阈值远小于合法步长（p99 693s），不会误放活 WU，又比现状 60min+ 快一个量级 |

注意：看门狗必须以 **stdout stream 行**为准而非 transcript——transcript 的 assistant 行在生成完成才落盘，stream-json 的逐行输出更及时，真实流式静默小于本表数字，600s 只会更安全。

## 6. 样本量与口径声明

- 健康步 n=38（studio 指纹会话 106 个切出 144 步，其中 106 步触碰失败 WU 窗口被隔离）。样本偏小，p99 仅供定档参考；建议 #54 落地后按 §5 的 300s warn 事件积累数据再收紧。
- 超杀 WU 共 31 个（07-28 起），精确 sid/tokens 匹配到 19 个；其余 12 个的会话可能落在未扫描的 cwd 桶或 CLI 未建会话即失败。
- `workunit:tokens` 事件 965 条中 941 条是测试污染（`wu-1` 等假 id，`executionSource=unavailable`），仅 24 条真实 `cli-usage`——该事件流作为数据源需先清洗。
- kimi provider 无生产执行数据（全部 profile=claude），本地 kimi 会话为交互式参考样本。

## 支线产物

知识引擎飞轮考察发现 4 个值得后续 effort 的问题，已留痕 `docs/issues/2026-08-09-knowledge-flywheel-handoff.md`。
