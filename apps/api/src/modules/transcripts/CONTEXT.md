# apps/api/src/modules/transcripts

### 职责

transcript 归档器（#97，#88 子票）：把会话原文落盘到数据区（经 `studioDir()`/`studioPath()`），供三个消费方共用——#99 WU 收尾批量提取（要全文）、handoff 摘要（要对话）、#85 执行质量评估（要执行痕迹）。本模块只建归档器 + 读取接口，不实现消费方提取逻辑。

另提供 HTTP 只读查看路由（#174，#60 C5）：`GET /api/v1/transcripts/:workUnitId`（认证，query `offset`/`limit` 分页，上限 100 — #359 起统一 `parsePagination`，原上限 50），经 `readTranscript` 读全文后 slice，文件不存在返回 200 空列表；workUnitId 拒绝含 `/`、`..` 的 id（防路径穿越）。注册见 `route-registry.ts`；前端查看器 `apps/web/src/components/workunit/TranscriptViewer.tsx`。

session:start/end 事件链路（#174）：agent-loop 把 `transcriptPath(wu.id)` 注入 task parameters，runner 发 session:start/end 时 payload 并入 `workUnitId` + `transcriptPath`（`packages/studio-agent` output-capture 的 extras 第 4 参）。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `transcriptPath` | `transcript-archive.ts` | 归档文件路径：生产 `studioPath('transcripts', '<workUnitId>.jsonl')`，测试改写隔离目录（纯函数，按 workUnitId 确定性推导） |
| `transcriptsDir` | `transcript-archive.ts` | 归档根目录：测试 → `os.tmpdir()/studio-test-transcripts/<per-进程子目录>`（#135）；生产 → `studioPath('transcripts')` |
| `isTestEnv` | `transcript-archive.ts` | 测试环境判定（`VITEST`/`NODE_ENV=test`），同 studio-log-path |
| `appendTranscriptStep` | `transcript-archive.ts` | 追加一步原文（JSONL 一行）；调用方 fire-and-forget 兜底 |
| `readTranscript` | `transcript-archive.ts` | 按 workUnitId 读取全文 transcript；文件不存在返回 `[]` |
| `TranscriptEntry` | `transcript-archive.ts` | 单步条目类型（workUnitId/sessionId/step/action/rawOutput/createdAt） |
| `AppendTranscriptStepArgs` | `transcript-archive.ts` | 追加入参类型 |
| `TRANSCRIPTS_DIR` | `transcript-archive.ts` | 归档根目录名 `'transcripts'` |
| default（router） | `transcript.routes.ts` | #174: `GET /:workUnitId` 只读分页查看（认证） |

### 设计决策

- **数据源**：agent-loop 每步 `result.rawOutput`（raw CLI stdout，provider 无关）。单一来源同时满足三方：全文 + 执行痕迹，非摘要级截断，不依赖 provider 的 CLI session jsonl 路径（claude `~/.claude/projects/...` 等）。
- **归档时机**：每步成功执行后追加一行（会话结束即完整，天然可检索）。
- **格式**：JSONL，一行一步（append-friendly；损坏行由 FileStore 读时跳过）。
- **路径**：生产经 `studioPath()`（读 `STUDIO_HOME`，dev/prod 隔离）；测试经 `isTestEnv` 改写 `os.tmpdir()/studio-test-transcripts/<per-进程子目录>`（同 studio-log-path 约定，防测试写生产 `~/.studio/transcripts`，per-进程子目录见 #135）；禁硬编码 `~/.studio`。
- **会话定位**：每行携带 `sessionId`（`metadata.sessionId` 已维护 WU→session 映射；WU 内可能因重建/续用切换）。
- **保留策略**：不主动 GC（最简；后续由 ops 按需清理）。
- **不落 metadata、不建独立索引**：路径由 workUnitId 确定性推导，无需在 `WorkUnitMetadata` 冗余存 archive 路径。

### 依赖关系

**上游**:
- `@dommaker/studio-shared`（`FileStore` 读写原语）
- `@dommaker/studio-shared/studio-dir`（`studioPath` 数据根解析）
- `apps/api/src/modules/agents/loop/agent-loop.ts`（写入方：每步成功执行后 `appendTranscriptStep`）

**下游**:
- #99 WU 收尾批量提取（`readTranscript` 读取方，已落地：role-memory/completion-extraction.ts）、handoff 摘要、#85 执行质量评估（后续实现）

### 注意事项

- `appendTranscriptStep` 写盘失败会抛出——agent-loop 用 `void ... .catch(() => {})` fire-and-forget，绝不阻断任务流程。
- `readTranscript` 经 `FileStore.readJsonl`（mtime 读穿缓存），写入后立即读一致。
- 测试隔离走 `isTestEnv` 改写（`os.tmpdir()/studio-test-transcripts/<per-进程子目录>`，文件名不变，#135），与 `studio-log-path` 同约定；生产路径的 `STUDIO_HOME` 解析由 `studio-dir` 单测覆盖。
