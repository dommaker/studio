# WorkUnit 写路径单口（2026-09-15）

> 来源：架构评审候选 C1（写路径 seam 泄漏收口）grilling 定稿。
> 状态：**accepted**（实现未落地——按票执行，见「实施切票」）。

## 背景

4 个写点绕过 WorkUnitService 直摸 FileStore 写原语：discord/routes（按钮 retry/abandon + `/studio stop`）、agents/monitor/monitor-lifecycle（90 天 TTL）、agents/ops/system-health（30 天 GC，**无生产接线，仅测试可达**）、triggers/trigger-action（UPDATE 动作，**当前零注册消费者**）。

#170 已统一锁内成对原语（commitSnapshot/commitRemoval 同一把 workunits flock），这四点绕过的是 **service 层语义**：状态机校验、workunit.status_changed 广播、wu-closure 双出声。已发生的实际损害：discord closeAndEmit 的 metadata 整写覆盖摧毁全部既有 metadata、不写 closedAt、不发 status_changed；墓碑事件行（closed + deleted:true）在三个调用方手抄；删除零事件 → 前端列表/抽屉悬挂到 SSE 重连 refetch。

## 决策

1. **WU 全部写路径唯一出口 = WorkUnitService 语义方法**（create/transitionStatus/update/delete/unclaim/claim + wu-closure 统一关闭 + updateMetadata 增量）。业务模块直调 FileStore 写原语即违规。#523 auditor 建单收口（消灭第二个建单口）的推广。**语义化入口，不开通用 safeCommit**——通用口过不了删除测试（删掉它复杂度只是搬家），且不知道调用意图就挂不住校验。
2. **discord**：abandon / `/studio stop` → `closeWorkUnitWithNotice`（原因走 opts，补 closedAt，落 workunit:closed 记录，频道出声）；retry → `unclaim`（回 unassigned + status_changed）+ 额外字段 updateMetadata 合并。停发 legacy `events:goal-execution` 事件（Goal 体系已退役）。
3. **GC / TTL**：筛选逻辑留调用方，删除循环调 `service.delete(id, { reason })`；delete 加 reason 参数。**不开批量方法**——当前只有一个活调用方（monitor TTL），一个调用方不成缝，等第二个真调用方出现再议。
4. **墓碑格式归存储层**：events 流墓碑事件行（closed + deleted:true）由 service.delete 单点构造，调用方不自拼（现状三处手抄收一处）。
5. **删除出声**：service.delete 发 `workunit:removed`（eventBus → SSE 桥转发白名单加条目），负载带 id + channelId（SSE 事件负载契约）。**只走事件流/SSE，不进频道**——GC 是数据卫生不是对账修复，不适用 #523「系统自作主张改了就该说」的频道口径。web 消费：workunitStore / channelWorkStore 各加删行分支。
6. **trigger UPDATE**：禁改 status（TriggerStore 注册校验拒 + executeUpdateAction 执行守卫，双保险），其余字段走 patchSnapshot 白名单，metadata 走 updateMetadata 合并。理由：当前零消费者（default-triggers 全 EXECUTE/CREATE，trigger store 空），YAGNI；将来真需要状态变更再转 transitionStatus，成本不变。
7. **TTL 筛选语义不动**（90 天无状态过滤照旧）——本收口只搬家不改行为，语义问题独立开票。

## 否决的备选（勿再提）

- **通用 safeWrite / commitSnapshot 包装口**：浅模块换名，删掉后复杂度只是搬家，校验挂不住意图。
- **批量 removeStale service 方法**：只有一个活调用方，不成缝。
- **GC 删除时频道出声**：数据卫生 ≠ 对账修复，频道出声口径（#516/#523）不适用。
- **trigger UPDATE 支持状态变更**：零消费者先收紧，将来按需开。

## 不修（另议，勿并进收口票）

- **关闭路径不广播**：wu-closure 不发 status_changed → 前端列表不实时刷新（discord abandon 收口后同现状，不回退也不提前修）= 架构评审候选 C2（双关闭路径合并）的开放问题。
- **monitor TTL「满 90 天删任何状态（含 active/blocked）」是否合理**：needs-triage。
- **system-health runGC 无生产接线**：接线 or 删除，needs-triage（收口票只迁它的写路径，不动接线状态）。

## 实施切票

1. **C4 前置票（机械）**：workunit-api.test 的 CI skip 根因排查 + 复活；workunit.types.ts L244-306 死 DTO 副本删除（三轴 grep 验证零消费）；两个占位桩测试文件处理。
2. **C1 主票**：四点按点 phase commit。测试面：service.delete 不变式（墓碑 + workunit:removed + reason）；trigger-update 既有「可写 status」断言随决策 6 反转（语义变更非删测试）；discord 按钮两路径从零补测试；system-health 测试补 WU 删除分支断言（现状未断言）。
