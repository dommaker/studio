# CONTEXT.md 流程内维护改造（去流水化）

> 日期：2026-08-03 ｜ 状态：**已完成**（2026-08-04 按 A→C→B→D→E 实施，偏差与结果见 §7）
> 背景诊断：doc-freshness 体系已退化为"git log/diff 复述器"——LLM 刷新半边全部坏死（fill-context-docs 后端被删未接回、sdd-freshness 落 append 兜底），只剩纯代码打标半边在跑，产物与 git 记录重复、只增不减、自我触发。证据：40 个 CONTEXT.md 含 337 条修复历史（235 机器 + 102 蒸馏）、docs/sdd 165 个 `Code Changes Detected` 兜底块、post-commit hook 卡 LLM 同步路径。
> 设计原则：**写在流程内（attended、零边际成本、自校验）；硬卡前置到 code-review（有人在场处）；commit 门只警告；机器写端全删；不接任何定时/后台 LLM 任务**（1.03 亿 token 教训）。

## 1. 目标 / 非目标

**目标**

1. 删除三个流水写端：post-commit sdd-freshness hook、session-summary 修复历史追加、STALE_SINCE 打标。
2. 把 CONTEXT.md 维护锚定到开发链终点：code-review 通过后 invoke exploration-sediment（链内 HARD-GATE 路由，不走 scope 关键词匹配）；**沉淀是 verdict=pass 的硬条件**。
3. pre-commit 加纯代码 CONTEXT.md 提醒门（只警告不拦截），覆盖不走链的变更。
4. 清理存量：STALE 标记、修复历史节（蒸馏条目分诊后处置）、docs/sdd 兜底块。

**非目标**

- 不接定时器/daemon 周期任务做任何文档维护（无人值守 LLM 循环这个范畴整个不要）。
- 不做 LLM 后置校验环（校验由"作者=修改者同人 + 交付回复沉淀清单人审"承担）。
- 不改 fill-context-docs（保留为手动修复工具，现状即手动）。
- 不动 agent-loop 的 WU 收尾守卫（§6-Q5：先度量，不达标再补）。
- 不动 SDD 文档本身（task-planner 产物，只删往它身上打补丁的机器）。

## 2. 改动清单

### A. 删机器写端

| # | 文件 | 动作 |
|---|------|------|
| A1 | `.git/hooks/post-commit` | 删除（本地 hook，不在 git）。**注意**：studio-prod checkout 若装了同一 hook，部署时一并删 |
| A2 | `scripts/sdd-freshness-check.ts`、`apps/api/src/modules/sdd/`（整目录：sdd-freshness.service.ts、CONTEXT.md、`__tests__/sdd-freshness.service.test.ts`）、`scripts/__tests__/sdd-freshness-check.test.ts` | 删除。仓内引用已 grep 确认仅 script → service 一处；studio-config 无引用；studio-prod 为同代码部署 checkout，下次部署自然消失。**SDD 文档（docs/sdd/）不动** |
| A3 | `apps/api/src/modules/agents/session-summary.service.ts` | 删 `updateContextFiles()` 方法及其调用（`summarize()` 内）；**保留** extractFixPatterns / extractFeatSummaries（KnowledgeBus 提取是另一回事） |
| A4 | `apps/api/src/modules/agents/system-executor.ts:109` | 注释中 sdd-freshness 提及顺手清理 |
| A5 | 受影响模块的 CONTEXT.md | D 清理时同步 |

### B. 开发链接入（skill 文件在 `~/.studio/skills/`，**不在 git 内**，改动即生效、无 commit）

| # | 文件 | 动作 |
|---|------|------|
| B1 | `code-review/SKILL.md` | 终端状态：spec status 同步后、push 前插入两步——**invoke exploration-sediment**（本轮实现 + review 发现按分流清单写入）→ **提交 CONTEXT.md 变更**（须在 push 前）。自检表加一行（**硬条件**，拦截 verdict）：「沉淀路由｜verdict=pass 前已 invoke exploration-sediment 或显式记录 N/A（无耐久发现）｜不满足则 verdict 不得为 pass」 |
| B2 | `exploration-sediment/SKILL.md` | 改决策树与维护规则（触发时机不动）：① 删「修复历史」落点行，修复教训并入「注意事项」坑条目；② 新增状态区规则——「核心导出/依赖关系」对照本轮 diff 做增改删，重写回当前真实状态，非追加；③ 新增自清洁规则——本轮修掉的坑，同 session 删除对应「另知：…（未修）」条目；④ frontmatter description 去掉「修复历史」 |
| B3 | `apps/api/src/modules/skills/manifest-generator.ts:71` | 链行改为 `design-analyst → spec-review-skill → task-planner → sdd-review-skill → tdd-implement → code-review → exploration-sediment`；改完跑一次性 regen（tsx 调 `generateManifest()`，或经 skill-store 任意一次写操作触发）刷新 `~/.studio/skills/MANIFEST.md` |
| B4 | `CLAUDE.md:66` | 删「修复条目追加『修复历史』（`<!-- SESSION_SUMMARY_FIXES -->` 标记下）」半句，保留其余 |

### C. pre-commit CONTEXT.md 提醒门（纯 bash，零 LLM，**只警告不拦截**）

`.git/hooks/pre-commit` 追加（形状参照现有 TDD 门，L74-119，但永不 exit 1）：

- staged 代码文件（`--diff-filter=ACMR`，限 ts/tsx/js/jsx）→ 逐文件向上找**最近的有 CONTEXT.md 的祖先目录**；
- 该 CONTEXT.md 未被一并 staged → 打印提醒（目录清单 + 一行引导："走链任务沉淀由 code-review 硬卡；非链任务请按 CLAUDE.md:66 收尾沉淀"），**exit 0 放行**。

决议理由（Q1）：无人值守提交（ship auto-commit）处不能有需人决策的阻断点；且 `.git/hooks` 不进 git，门仅本机生效，硬拦截代价（阻断 ship、被迫改写 phase commit 历史）与收益不匹配。真正的硬卡在 code-review 自检（B1）。

### D. 存量清理（一次性，attended）

| # | 动作 |
|---|------|
| D1 | 一次性脚本 `scripts/cleanup-context-history.ts`（跑完归档 `_archive/`）：扫 apps/packages 全部 CONTEXT.md → ① 删 `<!-- STALE_SINCE -->` 标记行 + `⚠️ 以下文件已变更` 行；② 删 hash 格式机器条目（`^- ✅ \`[0-9a-f]{7,10}\`:`，235 条）；③ **蒸馏条目（102 条）先人工分诊**：真坑/排查结论（预计 <10 条）改写进对应「注意事项」，其余随节删；④ 删空「修复历史」节 + `<!-- SESSION_SUMMARY_FIXES -->` 标记。跑完 `git diff` 人审再提交 |
| D2 | docs/sdd 165 个 `## Code Changes Detected` 兜底块：sed 机械清除（块边界 `## Code Changes Detected` → `> Auto-detected by SddFreshnessService` 可识别）。docs/sdd 仅 7 文件被 git 跟踪，diff 可审，其余为本地文件 |

### E. 验证

- `pnpm --filter @dommaker/studio-api test`（session-summary / agents 相关用例随 A3 同步删改）+ 全量 `pnpm test` 无回归；
- tsc gate（pre-commit 自带）通过；
- 门手动验证三例：① 改代码不改 CONTEXT.md → 打印提醒且放行；② 同时 staged → 无提醒；③ 无代码变更（纯文档提交）→ 无提醒；
- 链路由演练：一个真实小任务走完 tdd-implement → code-review（自检沉淀行）→ sediment → 文档 commit → push；
- 度量观察（Q5 配套）：跑数周后查 `knowledge:skill_used` 事件中 exploration-sediment 在 WU 链的触发率，不达标再议 WU 收尾守卫。

## 3. 覆盖地图（改完后）

| 任务类型 | 沉淀触发 | 强度 |
|---------|---------|------|
| 走完整开发链 | code-review 终点路由（自检行拦截 verdict） | **硬**（有人在场） |
| 不走链的杂活 | CLAUDE.md:66 软规则 + pre-commit 提醒门 | 软 + 提醒 |
| WU 管线 | 路由在 skill 文本（显式点名，不吃关键词匹配盲区）；worktree 共享主仓 hooks，提醒门同样生效 | 同链 |

## 4. 实施顺序

A（删写端，止血）→ C（提醒门）→ B（链路由）→ D（存量清理）→ E（验证）。

## 5. 备注

- 本文档需 `git add -f`（docs/ 在 .gitignore，plans 已有 17 文件例外入库先例）。
- skill 文件（`~/.studio/skills/`）无版本管理，建议改完自行备份/同步（仓旁有 skills-backup-* 先例）。
- studio-prod 侧部署时检查 `.git/hooks/post-commit` 是否残留。

## 6. 决议记录（2026-08-03 对齐）

- **Q1 门强度 → commit 只警告，"硬"前置到 code-review 自检**。理由：无人值守提交（ship auto-commit，证据 `9a7344ba`）处不能有阻断点；commit 时刻补救成本高（tdd-implement #9 要求 phase 独立 commit）；hooks 不进 git 仅本机生效。
- **Q2 蒸馏条目 → 分诊后删节，真坑挪「注意事项」**。理由：抽样显示多数是散文版 git log（变更叙事非教训）；信息只有"当前状态"与"耐久教训"两个合法归宿，变更叙事的家是 git log；条目零消费者（session-summary 只写不读）。全搬 = 流水换家污染注意事项，全删 = 误杀真坑，故人工分诊一次（预计挪 <10 条）。
- **Q3 sdd 模块 → 整删；SDD 文档不动**。澄清：modules/sdd 目录里只有 freshness patcher（service + CONTEXT.md + 测试），task-planner/sdd-review-skill 走 skill + FileStore 不依赖它；仓外无功能依赖（studio-prod 为部署 checkout 随部署消失）。
- **Q4 兜底块 → 清**。理由：165 次发射零次 integrate；"代码在 spec 之后变过"对时点规格是恒真废话，要查变化答案永远在 git；块边界机械可识别，清理风险零。
- **Q5 WU 收尾守卫 → 本期不做，先度量**。理由：链路由在 skill 文本对 WU 同样生效；worktree 共享 hooks 提醒门覆盖 WU 提交；`knowledge:skill_used` 事件已可度量实际触发率——不在软路径失效前建 enforcement，失效再补只是小 PR。

## 7. 实施记录（2026-08-04）

**代码演进偏差**（计划写于 2026-08-03，实施时 main 已演进）：

- A2/A4 被上游提交提前覆盖：`modules/sdd/`、`scripts/sdd-freshness-check.ts`、`system-executor.ts` 在 main 上已不存在，无需重复删。
- A3 落点变为 `session-summary-agent.service.ts`（agent 化迁移把旧 `updateContextFiles` 原样带了过去），在新文件上重做删除；旧测试 `session-summary.test.ts` 已随迁移消失，无需删改。
- B3 的 `manifest-generator.ts` 已被删除，`~/.studio/skills/MANIFEST.md` 现为手工维护文件——直接改链行与 exploration-sediment 描述，无 regen 步骤。

**D 实际数字**（vs 计划）：STALE 标记/警告行 55、hash 机器条目 40（计划 235，上游已清过一轮）、蒸馏条目 **0**（计划 102，前期提交已消化，免分诊）；docs/sdd 兜底块 165 → 0（19 文件，块尾即文件尾，jwt-auth-system 两文件中仅会话日志内嵌同名字符串、非兜底块，未动）。

**提交**：`8379e132`（写端下线 + tsc baseline 收录 main 存量 7 条错误，经用户决议）、`8b060ead`（16 个 CONTEXT.md 清理，-198 行）。一次性脚本归档 `scripts/_archive/cleanup-context-history.ts`（未入库——TDD 门对新 .ts 要求测试，一次性脚本不满足也不值得补）。

**master 移植**（2026-08-04 当日）：master 未含 main 的 agent 化迁移，写端仍以旧形态存在，存量数字与计划一致（234 机器 + 101 蒸馏 + 58 STALE）——按 A2/A3/A4 + D1 重做：蒸馏清单归档 `docs/_archive/2026-08-04-context-cleanup-distilled-triage.md`（本地）后随节删除，「注意事项」同期沉淀已覆盖耐久结论无需再搬；两笔提交（写端下线 -1150 行、39 文件清理 -578 行）。

**验证**：tsc gate 零新增错误（stash 对照确认）；agents 测试无回归（失败集为存量 prisma 环境问题，通过数持平）；提醒门手动三例全过，且在首个提交中真实触发一次。

**遗留**：① 链路由演练（E 第 4 项）需一个真实任务走链完成，待下次开发任务顺带；② studio-prod 部署时检查 `.git/hooks/post-commit` 残留；③ main 的 7 条存量 tsc 错误已入 baseline，后续单独治理。
