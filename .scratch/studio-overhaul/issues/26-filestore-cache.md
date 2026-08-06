# 26 — FileStore 缓存与复制段合并（A1+A2）

Type: task
Status: claimed
Labels: enhancement, ready-for-agent
Blocked by: 16

## Question

packages/studio-shared/file-store.ts：A1 内部加读穿缓存（接口零变化；写/删/rename 按路径失效；list* 串行读改并发）；A2 合并 Requirement 段（917-990）与 Evolution 段（1012-1085）逐行复制为单一泛型实现。在既有 file-store 测试 seam 上补缓存行为测试（写后读一致、失效正确、并发 list 等价）。证据 research/01、04。验收：typecheck+test 全绿（含新测），独立 commit（缓存、段合并可分两票）。
