# 频道默认角色（defaultProfileId）退役 + 合并窗口解耦 + 发送前归属预览（2026-09-23）

> 来源：架构评审「角色域」候选 3（2026-09-23），#632 裁决（grilling Q1–Q7 坍缩，Agent Brief 为形状正本）。
> 状态：**accepted**（本票落地）。

## 背景

频道默认角色（`channel.defaultProfileId`，消息路由第三优先级：无 replyTo、无 @mention 时兜底接单；@studio 转派也读它）是半上线功能：

- 生产数据零频道配置该字段（数据区频道记录实测零命中），零 `channel-default` WU、零 `@studio` 使用；
- 前端 web 的 `channelApi.update` 类型签名漏了 defaultProfileId，全仓无任何配置 UI；
- 它的主场景「对进行中的工作追问」已被合并窗口（#495，5 分钟内并入在途 WU）有机覆盖——而合并窗口嵌在 defaultProfileId 分支内，在生产从未激活；无 @ 消息一律纯存储（静默丢弃）。

裁决要点（grilling 坍缩）：无地址消息系统猜不准是"活"还是"聊"，自动建单会让垃圾工单被 agent 自动认领执行（最贵错误自动发生），因此默认必须 **fail-closed**——拿不准就不动，把"让它动起来"做成发送前可见、一键可选的显式动作。

## 决策

1. **退役 defaultProfileId（B 路）**：删除字段、决策12 建单分支、@studio 转派分支（@studio 此后按未匹配 mention 走既有「转自动认领」提示）、dispatch 埋点 `via=default-role`、PATCH 校验。路由链 4 环变 3 环：`replyTo` → `@mention` → 合并窗口 → 纯存储。
2. **合并窗口解耦 + 歧义守卫**：所有无 @ 无 replyTo 的人类消息一律先过合并判定（窗口默认 5 分钟 + WU 在途，语义同原 `findMergeTargetWorkUnit`），不再依赖任何频道配置；新增守卫——窗口内最近人类消息涉及 ≥2 个不同在途 WU（歧义）→ 不并入，落纯存储。守卫判定纯机械（数 distinct workUnitId），fail-closed。判定函数 `resolveMergeTarget` 返回三态「唯一目标 ｜ 歧义 ｜ 无目标」。
3. **发送前三态归属预览（web 输入框）**：复用 reply 引用预览条形态，发送前经只读端点 `GET /channels/:id/merge-target` 显示预测归属——默认「将并入：<WU 标题>」，可一键切换「新任务」（`intent='new-task'`，建未指派 WU 走涌现认领，`creationMode='channel-new-task'`）或「纯消息」（`intent='plain'`）；歧义时不显示并入目标，改淡提示「频道有多件事同时进行，请回复对应消息或 @角色」。预览与路由共用同一判定函数，保证「预览所见 = 实际路由」。
4. **历史数据兼容**：历史 `creationMode='channel-default'` 记录保留只读兼容，不做数据迁移；`PATCH /channels/:id` 携带 defaultProfileId 返回 400（防 silent no-op 误以为配置生效）。

## 出处更正

「决策12 默认角色」编号出自 F 期决策集（commit `aa23109d`），并非 ADR 2026-07-27 channel-pipeline-decisions 的 D12（该 D12 = 需求多轮交互，是合并窗口的决策依据）。引用时勿指错。

## 否决的备选（勿再提）

- **A 路（浮出水面做成真功能）**：频道设置加「默认角色」配置位 + web 类型补字段。否决理由：主场景已被合并窗口覆盖；自动建单是 fail-open 的最贵错误；生产零使用证明无真实拉力。
- **无地址消息自动建单（任何形态）**：系统猜不准"活"还是"聊"，垃圾工单会被 agent 自动认领执行。显式「新任务」按钮是唯一建单入口（@mention 除外）。

## 落点清单（#632 已交付）

- api：`resolveMergeTarget` 三态判定（message-routing.ts）+ 路由链重排 + @studio 转派删除 + `GET /:id/merge-target` + POST messages `intent` + PATCH 拒绝 defaultProfileId + 测试迁移与新增。
- web：`channelApi.getMergeTarget` / `sendMessage` intent 参数 + ChannelInput 归属预览三态条 + 测试。
- 类型：`ChannelData.defaultProfileId` 删除（packages/studio-shared）。
- 出范围（另开票）：派单默认挂频道「当前 PMO」；「转为任务」主动提示片；非代码类 WU 共享 cwd 串 session 观察票。
