# 频道数据面 store 与取数纪律底座（2026-08-31）

> 来源：架构评审第三轮「studio 性能方向」候选 N2（频道页同端点重复拉取）grilling 定稿。
> 状态：**accepted**。

## 背景

频道工作区（#377/#394 定稿的唯一页面形态）内多个组件对同一端点各自拉取：
`getFileVocabulary`×2、`getCurrentPmo`×2、`/agent-profiles`×4 种参数切片、
`/workspaces/runtimes` 每进页触发一次全量 CLI 重扫。rosterStore（#346）已证明
数据面 store 模式的价值，但其边界只盖 roster 三端点。

## 决策

1. **新建 per-channelId 频道数据面 store**，管词表 / 当前 PMO / 成员列表三样，
   机制照 rosterStore；rosterStore 本身不动。
2. **agent 列表不进频道数据面**。rosterStore 的 `listAllAgents`
   （`includeSystem=true&limit=200`）已是全量正本，是其余三种 query 形状的超集；
   App boot 检测、@提及补全、成员面板三处改读 rosterStore 客户端切片
   （注意保留「频道 members 为空 → 回退全部 active」语义）。同域数据不住第二份。
3. **新鲜度 = TTL + 白捡触发器，不新增 SSE 事件**。词表 / 当前 PMO / 成员列表
   均无失效事件（词表后端本有 60s 内存缓存，实时性从来不存在）；当前 PMO 在收到
   `requirement.created/updated` 时顺手失效（该事件已桥接，零成本）。成员列表在
   面板内修改成功后本地更新，不做多端实时（现状亦无）。
4. **useDetectedProviders 懒挂载**：成员面板首次展开才请求 `/workspaces/runtimes`，
   不再进页即扫。
5. **服务端 `/workspaces/runtimes` 挂 apiCache**：该端点每请求 `execFileSync`
   全量重扫所有 CLI（`which` + `--version`，timeout 5s/个），同步阻塞事件循环，
   最坏数十秒。按缓存 seam 决策树第 2 问（HTTP 响应、秒级陈旧可接受）挂 60s 档。
6. **取数纪律抽共用底座**：TTL 锚点 / single-flight + seq 守卫 / 重连强刷 /
   useGatedPoll 兜底 / 引用计数接线收成一个共享模块，rosterStore 迁移其上
   （行为不变，既有测试兜底）。只抽取数纪律，不抽数据存法——全局单份与
   per-key map 形状各自保留。

## 否决的备选（勿再提）

- **逐 store 复印机制**：人审提案卡生命周期曾复印 4 份漂移成 3 套词汇（见根
  CONTEXT.md「人审提案卡」），同剧本不重演。现有两个真实使用者 + 第三个排队
  （REQ chain 数据面，候选 N1），抽取正当。
- **为词表/PMO/成员新增 SSE 失效事件**：成本高且现状本无实时性，TTL 已够。
- **频道域端点塞进 rosterStore**：域混淆，rosterStore interface 无谓膨胀。

## 遗留（本 ADR 不管）

- agent-profile CRUD 事件在 eventBus 已存在但未桥接 SSE；channel members 变更连
  eventBus 事件都没有。若未来要多端实时，从这里接。
- REQ chain 数据面（N1）独立成票。
