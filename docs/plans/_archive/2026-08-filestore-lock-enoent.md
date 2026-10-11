# #210 file-store-base 锁测试 ENOENT rename flaky 修复

## 现象
全量 vitest 重负载并行下，`file-store-base.test.ts` #169 stale-lock 用例偶发 `ENOENT: rename owner.json.tmp`；单跑全过。

## 根因
`withLock` 获锁窗口（`mkdir(lockDir)` 成功 -> `writeJson(owner.json)` rename 完成）期间，锁目录可被并发回收方 `rm -rf`（stale 双判据：mtime 兜底/age，判据见 #64 决议 2）。rename 时目录/tmp 已不存在 -> ENOENT。现 catch 分支（L209-211）把该情况当致命写失败：rm + throw。语义缺口：目录已被回收 = 从未持锁，应回到竞争而非报错。

## 方案（最小改动）
`file-store-base.ts` `withLock`：owner 写入失败且 `err.code === 'ENOENT'` 时，不 rm/throw，跳回获取循环重试；重试受同一 timeoutMs 预算约束，超时抛 `LockTimeoutError`。其他错误维持原语义。

## 明确不做（范围外，另行记录）
- 持锁方 fn 超时被回收后 finally `rm` 可能误删新持有者锁目录（释放无属主校验）--设计缺口，工单留言记录，不在本单修。

## 验收
1. 新 RED 用例：owner 写入首抛 ENOENT -> withLock 重试成功（'acquired'），不 throw。
2. 原 32 用例 + 新用例全过。
3. type check 无错误。
