# 26 — FileStore 缓存与复制段合并（A1+A2）

Type: task
Status: resolved
Labels: enhancement, ready-for-agent
Blocked by: 16

## Question

packages/studio-shared/file-store.ts：A1 内部加读穿缓存（接口零变化；写/删/rename 按路径失效；list* 串行读改并发）；A2 合并 Requirement 段（917-990）与 Evolution 段（1012-1085）逐行复制为单一泛型实现。在既有 file-store 测试 seam 上补缓存行为测试（写后读一致、失效正确、并发 list 等价）。证据 research/01、04。验收：typecheck+test 全绿（含新测），独立 commit（缓存、段合并可分两票）。

## Answer

已解决，两个 commit：
- A1 `e6d29c8b`：模块级读穿缓存（json/jsonl/dir 三表按绝对路径 key，命中先 stat 比 mtime 防跨进程脏读，写/删/rename/upsert 精确失效）；命中一律 structuredClone 防 mutate 污染；7 个 list/query 方法串行改 Promise.all；新增 9 条缓存行为测试。
- A2 `cde5b4f8`：Requirement/Evolution 复制段收敛为 SeqEntryStoreConfig + 泛型私有实现，8 个对外方法签名不变。
typecheck exit 0，全量 test 3944 passed / 0 failed。遗留说明：同 mtime 粒度内外部写理论漏检（可接受）；queryAllMessages 罕见 fs 错误路径返回空（ENOENT 语义不变）。
