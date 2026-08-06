# 01 — API 后端源码调研

Type: research
Status: resolved

## Question

apps/api（247 个源文件）的结构与现实：模块清单与职责、臃肿混乱的业务逻辑热点、超大文件（agent-loop.ts 2017 行、knowledge-service.ts 1819 行、workunit.service.ts 1179 行、okr.service.ts 1156 行等）的内部结构与拆分面、明显性能疑点（N+1 文件读写、同步阻塞、重复计算、过密轮询/ws）、废弃注释与疑似死代码。产出可供架构规划直接消费的调研报告。

## Answer

已解决（subagent 调研）。报告：`../research/01-api-backend.md`。

要点：①性能总根因在 FileStore（零缓存零索引，list* 串行全量读），三大 P0 热点（全局 auth 中间件每请求全量读、AgentLoop.observe 每 15s 三轮全扫描、wu-messenger 每条消息全扫描）皆其变体，加带失效的内存缓存可消大半；②9 个热点文件拆分缝全部定位，共同规律"零依赖纯函数区先行"；③agents/ 目录 40 文件混 6 子域需重组；④发现 3 个正在运行的 bug（worktree GC 目录口径不一致、channel 分页 limit 失效、auth 类型漂移）+ 多处死代码（channel.routes 178 行死解析器、daemon 孤儿 574 行等）。
