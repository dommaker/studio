# 缓存 seam 决策规则（2026-08-24）

> 来源：架构评审「studio 性能优化方向」横切根因——缓存 seam 碎片化（候选 3/5/7/9 同构）；
> 本票（#314，计划：docs/plans/2026-08-wu-index-readthrough-lease-flush.md）为参照实现。
> 状态：**active**（2026-08-24 随 #314 实施落地）。

## 背景

studio 的缓存散住四个 seam，历史上各自为政、选型靠直觉：同一份数据可能在 FileStore
读穿缓存、api-cache 中间件、服务内 memo、调用方私有 Map 里各住一份，失效口径互不
知晓，写路径绕过其中一层就脏读。本 ADR 把「新缓存该住哪一层」固化为决策树。

## 四个 seam 与各自职责

| 层 | 位置 | 真源 | 失效机制 | 参照 |
|---|---|---|---|---|
| **FileStore 读穿** | `packages/studio-shared` FileStore 门面（jsonCache/jsonlCache/dirCache） | 磁盘文件 | 写/删精确失效 + stat mtime 校验（跨进程外部写靠 mtime 兜底） | 工单 26 A1；#314 getIndex |
| **api-cache 中间件** | `apps/api` middleware/api-cache.ts | HTTP GET 响应体 | 仅 TTL（short/medium/long/static 四档） | 路由级声明式挂载 |
| **聚合 memo** | 服务/模块内部（多源聚合计算结果） | 多次存储读 + 计算 | 按业务语义自定（TTL 或事件失效） | monitoring/knowledge 类聚合服务 |
| **调用方私有** | 单次操作/请求/loop 生命周期内的临时记忆 | 上游任一层的返回值 | 随作用域销毁 | 函数局部 Map、实例字段 |

## 决策树（新缓存按序自问）

1. **真源是磁盘文件（FileStore 管理的运行时数据）？**
   → 住 FileStore 读穿 seam。禁止在调用方再包一层文件内容缓存——那是第二真源，
   mtime 校验与精确失效全部失效。读多写少的文件读路径都应收进这个 seam（#314 的
   getIndex 即此例：25+ 调用方各自裸读 → 收回门面统一缓存）。
2. **缓存对象是 HTTP 响应、调用方是浏览器/外部客户端、秒级陈旧可接受？**
   → 住 api-cache 中间件。注意它只有 TTL 没有写失效：写后需立即一致读的端点
   **不得**挂这层，或必须显式 `clearCache`。
3. **缓存对象是跨多个存储源的聚合计算结果（非单一文件、非 HTTP 响应）？**
   → 住聚合 memo，贴着聚合函数放，失效口径写在函数旁注释里。
4. **只在单次操作内复用？**
   → 调用方私有，随作用域销毁。不得跨请求/跨 loop 轮次存活——需要跨作用域就
   上移回前三层之一。

两条横切规则：

- **真源唯一**：一份数据只住一个 seam；下层已缓存的，上层缓存的是「加工结果」
  而非「同一数据再抄一份」。
- **写路径必知失效**：新增写路径时检查其数据住了哪个 seam，保证失效链路存在
  （FileStore seam 靠 writeJson/appendJsonl 覆盖自动失效，绕开原语直写文件 = 破洞）。

## 例外条款：锁内读不缓存（#314 D1）

mtime 校验的读穿缓存是跨进程安全的，但 FileStore 的**锁内读路径**（claim/upsert/
租约落盘/updateMetadata/createSnapshotGuarded/reconcile）仍保持 `readIndexFile`
裸读：持锁场景要求读到的是「此刻最新」，不引入任何缓存层间接性，正确性论证只看
一处。这是刻意例外而非疏漏——给锁外只读路径加缓存时，不得顺手把锁内读也换掉。

## 增补：外部包引入的存储栈视同磁盘真源（2026-08-28，#343）

决策树第 1 问的「FileStore 读穿 seam」以数据经 studio-shared FileStore 门面管理为前提。
外部包自带的存储栈（例：harness `FileKnowledgeStore` 管理 `~/.studio/knowledge`，npm
固定版本，不在本仓改）不经该门面，但真源同样是磁盘文件 → **同样过决策树**，只是
第 1 问落不进 FileStore seam，按以下方式降级落地：

- **落点 = 第 3 问聚合 memo**：贴着存储栈的组装单例放（#343 = knowledge-singletons
  的 `sharedStore`，包装类 `knowledge-store-memo.ts`），不在调用方各自包缓存。
- **失效口径 = 借用第 1 问的机制**：本进程写穿透失效（save/update/delete 同步清
  memo）+ mtime/size 目录指纹校验兜底跨进程外部写——与 FileStore 读穿 seam 同一
  信任级别；残余风险同量级（外部同毫秒等长改写不可见）。
- **语义基线**：包装后对外行为与底层 store 等价——命中返回深克隆，保持底层
  「每次读返回全新对象」的既有契约（调用方会原地改嵌套数组）；显式磁盘核对路径
  （readEntriesFromDisk 一类）直通不缓存。

参照案例：#343 知识库——`injectContext` 每执行步 4 次全库同步扫描（N+1
readFileSync），memo 后稳态每步 = 指纹校验 + memo 查，零文件重读。长期方向
（另票）：知识库收进 FileStore seam 后，本条款对该数据不再适用。

## 参照案例：#314 WU index

- `getIndex`（锁外只读，25+ 调用方）→ 收回 FileStore 读穿 seam（决策树第 1 问），
  保留撕裂抛错的严格语义；
- 租约心跳（高频小写）不是缓存问题而是**写合并**问题：内存缓冲 + 60s 合并落盘，
  权威 fencing 复核与写入同锁原子——「高频小写合并落盘」与缓存 seam 正交，
  同样记录于此作为同类问题的参照。
