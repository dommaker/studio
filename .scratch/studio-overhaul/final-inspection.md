# 工单 43 — 最终架构巡检报告

> 日期：2026-08-07 ｜ 巡检范围：git 46a2cf8f..HEAD（全量重构 35 张工单闭环后）
> 词汇遵循 codebase-design：模块 / 接口 / 实现 / seam / 深度 / locality。

## 一、门控终验

| 门控 | 基线 | 巡检基线复测（HEAD d1584b4d） | 处置后终验（HEAD ae200f24） |
|------|------|------|------|
| `pnpm typecheck` | exit 0 | ✅ exit 0（tsc-gate 无新增错误） | ✅ exit 0 |
| `pnpm test` | 3987 passed / 0 failed | ✅ 3987 passed / 0 failed（417 文件） | ✅ 3973 passed / 0 failed（连续 2 次，见 B1） |
| `pnpm lint` | 0 错误 275 告警 | ✅ 0 错误 275 告警（spec 14 + agent 25 + web 236） | ✅ 0 错误 273 告警（C2 清除 2 条新引入告警） |

测试数 3987→3973 的 14 差额 = B2 删除 knowledge-search-analysis 连带的 14 个测试用例，非退化。

## 二、追加检查项处置

### B1 knowledge-bus-sync.test.ts 计时器 flake — 已修复（65314a01）

诊断：mock execFile 回调经 `process.nextTick` 触发，游离于假时钟之外；logger 计数断言依赖 `advanceTimersByTimeAsync` 内部 yield 与 nextTick 队列的交错时序，全量跑 CPU 竞争下偶发漂移。试验中还发现 sinon 边界语义：**推进窗口内新建、到期点恰等于窗口终点的定时器本轮不触发**（留到下一轮）——`setTimeout(cb, 0)` 变体因此确定性失败，backoff 用例 20s 到期点与窗口终点重合必漏一次。

加固（跟随仓内稳健写法的精神：一切时序确定性驱动）：
- mock 回调改为同步触发，全部状态迁移发生在定时器触发栈内，无微任务/边界交错；
- backoff 用例第二步推进垫 1ms（15_001），避开到期点与窗口终点重合；到期点本身不变，gap 精确断言不受影响。

验证：单文件连跑 3 次全绿；终态全量连续 2 次全绿（3973 passed / 0 failed，exit 0）。

### B2 knowledge-search-analysis 零生产调用 — 已删除（a01530c1 + da059dcf）

grep 终验：`analyzeKnowledgeSearch`/`extractKnowledgeEntryIds`/`KnowledgeSearchAnalysis` 生产引用为零，仅 agent-loop 单测经 re-export 消费。连带删除：模块本体、`agent-loop.ts` re-export 与头注释、`agent-loop.types.ts` 的 `KnowledgeSearchAnalysis` 接口、测试两个 describe 块（14 用例）、agents/CONTEXT.md 两处条目。

### B3 studio-shared dist/ 部分跟踪 — 已停止跟踪（583f67b5）

证据判定：**不应跟踪**。
- 根 `.gitignore` 第 5 行 `dist/` 规则自始覆盖该路径（`git check-ignore --no-index` 证实），7 个包中 5 个 dist 零跟踪；
- 运行时经 exports `default` 解析到 `src/`，vitest 亦 alias 到 src，dist 仅 `types` 字段引用、无需入库；
- studio-agent dist 内 `agent-completer.js` 源文件已在删除批次移除仍残留产物，证明跟踪态只会持续漂移。

处置：`git rm --cached` 264 文件（studio-shared 260 + studio-agent 4），本地 dist 保留供 typecheck 的 types 解析；gitignore 无需补全（规则已覆盖）。存量漂移随之失效。

## 三、孤立死代码与无用导入专扫

### C1 删除批次连带孤儿复扫 — 生产代码零漏网，文档漂移已修（ae200f24）

对工单 09–23、44 Answer 删除清单逐项抽查（ioredis、zod×4、review 四件簇、design-lab、multer/undici/node-fetch、死端点、STUDIO_TASK_QUEUE_ENABLED、各包 barrel/样式/常量/类型/helper）：**生产代码与依赖层面零漏网**。发现的漏网全部为文档漂移，已修复：
- AGENTS.md / CAPABILITIES.md 经 `harness sync-docs --agents` 再生成 + 手工修正：移除已删模块条目，27 条 agents/ 重组陈旧路径更新为 6 子域新路径（根 295 行、api 126 行现存条目全部指向实存文件，脚本校验 0 stale）；
- studio-agent/CONTEXT.md 移除 ioredis 依赖行；route-registry/companies CONTEXT 移除已删 useCompanyId 引用；style-guide.md 同步 design-lab 状态（docs/ 不入库，仅本地修正）。

### C2 无用导入（本次新引入）— 已清（9407d07b）

以 275 条 no-unused-vars/no-explicit-any 告警为入口，与 46a2cf8f..HEAD 改动文件（668 个）求交，新引入仅 2 条：api-interceptor.test.ts 未使用的 `api` 导入、SidebarNew `handleNavClick` 未使用的 path 形参（i18n 移除遗留）——均已修。存量历史告警未动。

### C3 零引用导出回潮 — 已清（9407d07b）

对本周新增 33 个源文件逐一提取导出符号并全仓 grep 验证：`AuditLogListResponse`（auditLogs.ts）、`KRValidation`（okrMetric.ts）、`NotifyField`（NotifyChannelSection.tsx）三个类型仅模块内消费，去掉 export。其余导出均有消费方。

### C4 package.json 依赖一致性 — 已清（d3cc06ab）

本周动过的 9 个包逐一做 import 比对并人工复核（防止类型包/配置引用误伤）：
- apps/api 卸载 ajv、ajv-formats、yaml（全仓零 import）；
- apps/web 卸载 @dommaker/harness、@dommaker/studio-api（零 import；后者指向 apps/api 本体，非幽灵依赖）；
- studio-audit、studio-notification 卸载 @dommaker/harness（零 import）。
lockfile 已同步（pnpm install 通过），typecheck 绿。

## 四、架构健康抽查（只记录，不重构）

- **FileStore 缓存 seam（studio-shared/file-store.ts:243-290）**：接口零变化的纯实现加深，读穿缓存三桶（json/jsonl/dir）+ mtime 校验 + 写/删精确失效 + 命中返回 structuredClone 防污染——典型深模块，小接口大实现，缓存一致性注释写清了跨进程重读口径，seam 健康。
- **agents/ 6 子域**：loop 14 文件/3428 行、auditor 4/1277、monitor 6/1655、ops 3/1065、knowledge 4/580、triage 1/520。按内部 Agent 职责切分，service+rules+reports 同处，locality 好。浅模块嫌疑：triage 目前单文件成域，目录 seam 价值低（语义仍清晰，可接受）；agents/ 根仍留 12 个跨域文件（2480 行），与子域边界靠命名约定维持。agent-loop.ts 余 1539 行——拆出纯函数后剩下的是真编排复杂度，深度尚可但接近上限，建议观察。
- **web api 层**：13 个领域模块 + index（axios 实例 + 鉴权/401 刷新队列拦截器）。裸 fetch 收编后 seam 完整；各模块导出的 xxxApi 对象偏浅，但 adapter 层职责恰是薄，深度集中在拦截器，划分合理。
- **ui/ 通用件**：Button/ConfirmDialog/Modal/Select/ManualTaskButton，全部由 F2/F3 真实消费方驱动抽取，非投机 seam；ConfirmDialog 组合 Modal+Button 而非继承；Button 包装 theme.css 类体系而非另起样式源。观察项：ManualTaskButton（4 消费方）内部自建 loading 逻辑，与 Button loading 态存在收编空间，非问题、不重构。

## 五、遗留问题清单

### 已修复（本巡检内闭环）
1. B1 计时器 flake 加固（65314a01）
2. B2 knowledge-search-analysis 删除及连带（a01530c1、da059dcf）
3. B3 studio-shared/studio-agent dist 停止跟踪（583f67b5）
4. C1 文档漂移 6 处 + CAPABILITIES 全量 stale 清零（ae200f24）
5. C2 新引入无用导入 2 处（9407d07b）
6. C3 零引用导出 3 处（9407d07b）
7. C4 未使用依赖 7 项卸载（d3cc06ab）

### 建议后续工单（不阻塞交付）
1. `.harness/context-fill-state.json` 残留 7 条已删目录的陈旧状态条目——harness 内部状态文件，建议由 harness 自身机制清理而非手改。
2. `docs/specs/` 历史规格文档（SM-013、GEN-006、db-removal/* 等）引用已删模块——历史档案性质，且 docs/ 不入库，低优先级。
3. vitest 全量收尾 `close timed out after 10000ms` + hanging-process 警告（globalSetup API server 关闭超时）——基线既有，不影响绿/红判定。
4. agent-loop.ts 1539 行接近单文件复杂度上限；agents/triage 单文件成域——均为观察项，下次触及该域时再评估。
5. 存量 273 条 lint 告警（no-explicit-any 为主）为历史基线，如需清零建议单独立项分批处理。

## 六、总体结论

**达到交付状态。** 三道门控终验全绿且与基线一致（测试数差额为删除连带的预期变化）；三项追加检查项全部按证据处置；死代码/无用导入/零引用导出/依赖一致性四类专扫的生产层面问题全部清零；架构抽查未发现需要立即返工的 seam 破坏，浅模块嫌疑均为可观察级别。剩余遗留均为文档档案/harness 内部状态/历史基线性质，不阻塞闭环。
