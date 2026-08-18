# kimi CLI usage 出口调研（#134 附属结论）

> 调研日期 2026-08-18，本机 kimi-code CLI **0.36.1**（#133 矩阵测的是 0.34.0）。
> 方法：`kimi --output-format stream-json --prompt "Reply with exactly: OK"` 实测 +
> 会话落盘文件只读走查（`~/.kimi-code/sessions/`）。

## TL;DR

kimi **有 usage 出口，但不在 stdout**。stream-json stdout 依然只有 meta/assistant 事件
（与 0.34.0 相同）；usage 落在**会话 wire 文件**
`~/.kimi-code/sessions/<wd-slug>/<session_id>/agents/main/wire.jsonl` 的
`usage.record` 事件里，字段齐全（含 cache 两桶）。

## 实测证据

stdout（0.36.1，与 0.34.0 形态一致，无 usage、无 verbose/stats 开关——`kimi --help` 全量确认）：

```jsonl
{"role":"meta","type":"system.version","version":"0.36.1"}
{"role":"assistant","content":"OK"}
{"role":"meta","type":"session.resume_hint","session_id":"session_488c752b-...","command":"kimi -r session_488c752b-..."}
```

wire.jsonl 同一会话内的 usage 事件（每 turn 一条，`usageScope:"turn"`）：

```json
{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":2993,"output":26,"inputCacheRead":18944,"inputCacheCreation":0},"usageScope":"turn","time":1787060014710}
```

字段映射到落账四桶：`inputOther` → inputTokens，`output` → outputTokens，
`inputCacheRead` → cacheReadTokens，`inputCacheCreation` → cacheCreationTokens。
（`step.end` 循环事件内嵌同名 usage 对象，同口径。）

## 结论与处置

- **本票（#134）kimi 分支维持 stdout 解析 = null**：解析链的输入是 CLI stdout，
  wire 文件是带外通道，不属于同一条链。诚实口径保持「未上报」，
  `workunit:tokens` payload 有 provider 字段后，kimi 的 unavailable 与 0% 命中可分。
- **wire 出口可落账，留给后续票**：wire 路径含 `<wd-slug>`（cwd 派生）与 session_id，
  session_id 可从 stdout 的 `session.resume_hint` meta 事件解析（agent-loop 链路
  非 claude 不下发 sessionId）。要接需在执行收尾后按 (cwd, sessionId) 定位 wire.jsonl
  聚合 `usage.record`——是新一轮「带外 usage 采集」设计，不是本票解析链分流。
- **上游需求（kimi-code 产品侧）**：stream-json stdout 增加 usage 事件
  （对齐 claude result 事件 / opencode step_finish），一条链通吃。
  未提 issue——待负责人确认后提。
