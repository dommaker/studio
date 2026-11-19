# apps/api/src/modules/transcripts

### 职责

transcript 归档器（#97，#88 子票；#712 完整性）：把会话原文落盘到数据区（经 `studioDir()`/`studioPath()`），供恢复包、#99 WU 收尾提取、#85 执行质量评估（后续）与 Skill 使用扫描共用。归档按 Assignment 区分写入中、已提交和失败内容，每类消费者拥有独立持久水位；本模块不实现消费方提取逻辑。

另提供 HTTP 只读查看路由（#174，#60 C5）：`GET /api/v1/transcripts/:workUnitId`（认证，query `offset`/`limit` 分页，上限 100），经 `readTranscript` 读 committed 内容后 slice，文件不存在返回 200 空列表；workUnitId 拒绝路径穿越。注册见 `route-registry.ts`；前端查看器 `apps/web/src/components/workunit/TranscriptViewer.tsx`。

session:start/end 事件链路（#174）：agent-loop 把 `transcriptPath(wu.id)` 注入 task parameters，runner 发 session:start/end 时 payload 并入 `workUnitId` + `transcriptPath`（`packages/studio-agent` output-capture 的 extras 第 4 参）。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| index.ts | 模块公共出口（barrel） | P2-c 立界：跨模块唯一合法 import 面；深路径 import 由 eslint `local/no-deep-module-import` 拦截 |
| `transcriptPath` | `transcript-archive.ts` | 归档文件路径：生产 `studioPath('transcripts', '<workUnitId>.jsonl')`，测试改写隔离目录 |
| `transcriptStepRef` / `parseTranscriptStepRef` | `transcript-archive.ts` | 本模块 `#step=` 引用的唯一构造/解析口，供 StepRecord、恢复与对账共用 |
| `transcriptsDir` | `transcript-archive.ts` | 归档根目录：测试 → `os.tmpdir()/studio-test-transcripts/<per-进程子目录>`；生产 → `studioPath('transcripts')` |
| `isTestEnv` | `transcript-archive.ts` | 测试环境判定（`VITEST`/`NODE_ENV=test`） |
| `appendTranscriptStep` | `transcript-archive.ts` | await 追加一步原文并返回带稳定 `contentId` 的记录；新 Assignment 步骤在 terminal 前不可见 |
| `finalizeTranscriptAssignment` | `transcript-archive.ts` | 追加 succeeded/waiting/failed/superseded/cancelled 终止标记；缺步骤可强制 failed |
| `reconcileTranscriptAssignments` | `transcript-archive.ts` | 按 WU 当前 Assignment/StepRecord 补终止标记；预期步骤缺失时 fail-closed，不提交成功段 |
| `readTranscript` | `transcript-archive.ts` | 默认只读 committed 步骤与 terminal；写入中/失败段不返回，文件不存在返回 `[]` |
| `consumeTranscript` | `transcript-archive.ts` | 读取指定 consumer 的 committed 增量（恢复包可 replay），callback 成功后才追加其 watermark |
| `TranscriptEntry` | `transcript-archive.ts` | step/terminal 公共读类型（workUnitId/assignmentId/sessionId/step/action/rawOutput/contentId/status/createdAt） |
| `TRANSCRIPTS_DIR` | `transcript-archive.ts` | 归档根目录名 `'transcripts'` |
| default（router） | `transcript.routes.ts` | `GET /:workUnitId` 只读分页查看（认证） |

### 设计决策

- **数据源**：agent-loop 每步 `result.rawOutput`（raw CLI stdout，provider 无关）。全文与执行痕迹保留，不依赖 provider 的 CLI session jsonl 路径。
- **提交边界**：每个带 Assignment 的新步骤显式记 `kind:'step'`；succeeded/waiting terminal 提交该 Assignment 段，failed/superseded/cancelled 段不进入默认读口。仍在写入的步骤不会被恢复或提取当成完整记录。
- **内容身份**：step/terminal 的 `contentId` 是身份与内容的 SHA-256；重试追加在读侧去重。step 沿用 WU 全局步号，terminal 记录本 Assignment 最后步号。
- **独立水位**：consumer watermark 与原文同存 `transcripts/<wuId>.jsonl`，记 `consumer + throughContentId`；没有侧车文件或新数据目录。处理失败不推进；锚点丢失时重放 committed 内容，绝不静默漏读。
- **至少一次消费**：跨文件副作用与水位不宣称 exactly-once。Skill 聚合按 `(skill, WU)` 去重；角色记忆成功哨兵与水位共同吸收正常重试，外部副作用成功后的崩溃仍允许 at-least-once 重放。
- **兼容**：旧的无 `kind` 步骤视为历史 committed 记录，不重写旧文件；HTTP 契约只 additive 增加 contentId/kind/status/reason，watermark 不经 HTTP 暴露。
- **路径**：生产经 `studioPath()`（读 `STUDIO_HOME`）；测试经 `isTestEnv` 改写 per-进程临时目录；禁硬编码 `~/.studio`。
- **保留策略**：不主动 GC。

### 依赖关系

**上游**:
- `@dommaker/studio-shared`（`FileStore` 读写原语）
- `@dommaker/studio-shared/studio-dir`（`studioPath` 数据根解析）
- `apps/api/src/modules/agent-loop/loop/`（步骤落盘与 Assignment 终止对账）

**下游**:
- 恢复包（workunit/recovery.ts）、角色记忆提取（role-memory/completion-extraction.ts）、Skill 使用扫描（skills/skill-usage-scan.ts）；#85 执行质量评估为后续消费方。

### 注意事项

- **鉴权（P2-e 声明式统一）**：requireAuth 由 route-registry entry 统一挂载。
- **契约正本**：`packages/studio-contract/src/transcripts.ts`；响应统一 `{ data }` 壳。
- `appendTranscriptStep` / terminal / watermark 写盘失败会抛出；AgentLoop 记日志但不阻断任务，消费端按当前 WU 快照重试对账。
- `readTranscript` 经 `FileStore.readJsonl`（mtime 读穿缓存），写入后立即读一致；损坏行由 FileStore 跳过。
- 测试隔离走 `isTestEnv` 改写 per-进程临时目录；生产路径的 `STUDIO_HOME` 解析由 `studio-dir` 单测覆盖。
