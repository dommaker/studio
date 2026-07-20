# 2026-07 文档治理闭环设计

> 依据：`docs/vision-2026.md` §5.2（文档治理 = harness 约束体系 + sync-docs + AGENTS.md 生成 + README 保鲜 + doc-freshness-check 入 CI）。
> 状态：设计待评审。前置事实：2026-07-20 清理批已删除 auditor doc-freshness 消费端与 CI 空转 step（见 §1），本文定义替代体系。
> 执行轨道：**α（文档治理）**，与其他三份文档零文件重叠，可独立并行实施（P0+P1）。

## 1. 现状审计结论（全部已查证）

| 层 | 机制 | 现状 | 证据 |
|---|---|---|---|
| 生成 | `harness sync-docs`（CAPABILITIES.md / CONTEXT.md / CHANGELOG 辅助） | 可用；CI 在跑 `--check` 但是 advisory | `ci.yml:40-41`（`continue-on-error: true`） |
| 声明式检测 | harness `FreshnessRunner`（changelog_version / context_docs / doc_dir_check 双向 / doc_regex_count）+ `FreshnessAutoFix` | harness 自用且有效；**studio 未配置**（`.harness/config.yml` 无 `governance.doc_freshness`） | `harness/src/core/constraints/doc-freshness/runner.ts`；harness 自身 `.harness/config.yml:13-53` |
| 启发式检测 | `harness doc-freshness-check`（regex claim 提取 + grep 对照） | 对 CAPABILITIES.md 实测"未发现可验证的声明"恒 exit 0；status 声明无条件 pass、narrative 不提取 | 2026-07-20 本地实跑；`doc-freshness-check.ts:264-271` |
| issue→auto-fix | auditor `handleDocFreshnessIssues` | 四关节全断（无 issue 生产者 / 重检脚本缺失会误判关 issue / JSON 形状错配 / 替换方向反转） | **已删除**（2026-07-20 清理批） |

**第一性结论**：「文档新鲜」不是单一属性，而是三类对象，各自由不同机制保证——零 LLM 对前两类是正确设计（确定性、可 CI、零成本），对第三类从根基上够不着，必须交给 agent：

| 新鲜度类别 | 例子 | 正确机制 |
|---|---|---|
| 结构/计数（可从代码生成） | 模块清单、目录结构、版本号、命令计数 | **生成式**（sync-docs / AGENTS.md 生成），新鲜由构造保证；CI `--check` 防漂移 |
| 机械声明（有代码真源但不能生成） | 手写文档里的"N 个命令"、链接有效性 | **声明式检测**（FreshnessRunner，oracle 由项目写明，不靠猜） |
| 语义新鲜（无代码真源） | "这段架构描述还是不是现状" | **agent 审查**（LLM 判断）→ 人确认；任何零 LLM 工具都不该承诺这一类 |

治理第一原则：**能生成的就不手写**——先减少需要保鲜的文档数量，再对剩余手写部分分层检测。

## 2. 闭环设计

```
┌─ 生成：sync-docs（CAPABILITIES/CONTEXT）+ AGENTS.md 生成（新能力）
│         原则：可从代码生成的内容禁止手写
├─ 检测：CI blocking 门禁 = sync-docs --check + harness check（含 FreshnessRunner 声明式配置）
│         启发式 claim 检查降级为对手写文档的可选扫描，不进 gate
├─ 审查：trigger（weekly）→ CREATE WorkUnit → agent CLI 语义审查 README/docs 手写篇
│         产出差异清单发频道
├─ 修复：机械差异 → 重跑 sync-docs 重生成（自动 PR）
│         语义差异 → agent 修改提案 → 频道卡片 → 人确认后落地
└─ 度量：漂移检出数 / 自动修复率 / CONTEXT.md 覆盖率 / 语义发现·修复数 → 监控页
```

角色归属：harness = 生成 + 确定性检测引擎（自有资产）；studio = 编排（trigger / WorkUnit / 频道确认卡）；agent = 语义判断；人 = 确认。**不重建 auditor 的 issue→auto-fix 链路**；narrative 差异不追求自动修复，走"agent 提议 + 人确认"。

## 3. 落地步骤

### P0：声明式门禁（纯配置，本周可做）

1. studio `.harness/config.yml` 增加 `governance.doc_freshness`（仿 harness 自身配置 `.harness/config.yml:13-53`），草案：
   - `doc_regex_count`：CAPABILITIES.md 模块计数 ↔ `packages/*/src/services` 等真实目录计数（先盘点 sync-docs 生成格式再定 pattern）；
   - `doc_dir_check`：CLAUDE.md / README.md 的模块章节 ↔ `apps/`、`packages/` 双向覆盖；
   - `context_docs`：核心源码目录必须有 CONTEXT.md（复用 `governance.context_files` 的 requiredDirs）；
   - `changelog_version`：CHANGELOG.md ↔ package.json。
2. CI 调整：`sync-docs --check` 与 `harness check` 从 advisory 提为 blocking（去掉 `continue-on-error` 或单设 step）；启发式 `doc-freshness-check` 不再进 blocking（如保留，只对 README/docs 手写篇跑并报告）。
3. 验收：故意改目录不更新文档 → CI 红；修复后绿。

### P1：AGENTS.md 生成 + 语义审查 trigger

4. AGENTS.md 生成落地（vision §5.2 标注的"新增能力"）：先模块级（`apps/api/src/modules/*/CONTEXT.md` → 聚合生成根 AGENTS.md 片段），接入 sync-docs。
5. `default-triggers.ts` 新增 `doc-semantic-review`：SCHEDULE weekly → CREATE WorkUnit（type: analysis），scope 模板：「审查 README.md 与 docs/ 手写文档（清单由 agent 自行定位）同当前代码结构/行为的一致性；产出差异清单（doc/行/文档声称/代码现状/建议）发频道；机械类差异同时给出 sync-docs 重生成命令」。
6. 差异处置：agent 在频道发提案卡（复用 evolution `channel-review.ts` 卡片交互模式），人确认后由 agent 执行修改或人工处理。
7. 验收：trigger 触发 → WorkUnit 被 claim → 频道出现差异报告；注入开销 ≤2K 红线不破。

### P2：度量

8. 监控页「文档治理」区：CI 漂移检出次数、sync-docs 重生成次数、CONTEXT.md 覆盖率、语义审查发现/修复计数（数据源：`~/.studio/logs/studio-events.jsonl` 新增 `doc:*` 事件）。
9. 验收：看板数据为实算（无数据时显式 insufficient-data，同飞轮看板口径）。

## 4. 明确不做

- 不恢复 auditor issue→auto-fix 链路（已删，机制上被生成式+声明式覆盖）。
- 不做 narrative 差异的自动修复（零 LLM 修不了语义，LLM 自动改手写文档无人确认风险高）。
- 不给启发式 claim 检查配置 blocking gate（oracle 是硬编码猜测，跨项目不可靠）。
