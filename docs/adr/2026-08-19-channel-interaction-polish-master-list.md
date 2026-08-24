# 频道交互打磨清单定稿：决策集汇总 + 优先级排序（2026-08-19）

> 本文档是 wayfinder 地图 [#245 频道交互打磨](https://github.com/dommaker/studio/issues/245) 的收尾产出（收尾票 [#260](https://github.com/dommaker/studio/issues/260)）。
> 地图目的地 = 设计定稿（决策集）+ 排好优先级的打磨清单。**实现不在本清单内——另起 effort 排期。**
> 状态：**已定稿，待排期实现**。

## 一、决策集汇总

地图期间全部决策票的结论索引（gist 见各票决议评论与地图 #245 的 Decisions-so-far）：

| 决策 | 票 | 一句话结论 |
|------|-----|-----------|
| 频道展示 UX（过程展示/布局宽度） | [2026-08-18 决策文档](./2026-08-18-channel-display-ux-decisions.md)，经 #245 开图共识第 5 条并入 | 过程展示落右抽屉 ExecutionSteps + 频道轻量 live 状态条 + 布局放宽（≥1440px → ~1000px） |
| 消息布局与渲染范式 | [#248](https://github.com/dommaker/studio/issues/248) | 混合分侧（人右轻气泡/agent 左无气泡文档流）；仅 agent 渲染 Markdown（复用 MarkdownBody）；mention chip + 文件 chip；Esc 关弹框 + IME 守卫 + observed-top 滚动台账 |
| @文件/资源引用模型 | [#249](https://github.com/dommaker/studio/issues/249) | 候选集=频道相关工程（UX 划界非安全边界）；meta.files={repo,path}；统一 @弹框分组；归属链新 rung「文件引用」 |
| @文件引用上下文预算与降级 | [#257](https://github.com/dommaker/studio/issues/257) | files 段=稳定前缀最末、定额 400 参与池共享；块级截断 + 未注入计数播报，不拒收不问人 |
| 人审交互统一 | [#250](https://github.com/dommaker/studio/issues/250) | 三分工（提案卡就地/闸门抽屉/NEED_INPUT 流内）；死按钮修复接线；NEED_INPUT 结构化选项 + 顶栏待办 chip |
| 频道绑定呈现与页面跳转链路 | [#251](https://github.com/dommaker/studio/issues/251) | 「默认工程」=本地 repo（顶栏下拉，落 defaultPath）vs「默认执行机器」=远程 Workspace（正名挪设置区）；publish 回写 channelId；通知铃接后端 API |
| NEED_INPUT 工程归属问答匹配 | [#258](https://github.com/dommaker/studio/issues/258) | 候选集排除清单落 ~/.studio + 设置页管理；匹配分层命中即停（精确等值→尾段边界唯一→子串）；多候选复用结构化选项卡 |

定级与事实依据来自三份研究报告（均在 `.studio/research/`）：

- dsh web 聊天交互可借鉴点盘点 `.studio/research/2026-08-19-dsh-web-interaction.md`（#246，P0/P1 借鉴清单；在 `research/dsh-web-interaction` 分支）
- [频道全链路 e2e 走查](./../../.studio/research/2026-08-19-channel-e2e-walkthrough.md)（#247，18 条发现 F1-F18）
- 生产环境只读复验 `.studio/research/2026-08-19-prod-readonly-recheck.md`（#259，SSE 阻塞坐实 + F12 补实；在 `research/prod-readonly-recheck` 分支）

## 二、打磨清单（统一排序）

分档标准（grilling 定夺）：

- **P0** = 链路阻塞：生产用户实际不可用
- **P1** = 已定稿的核心交互落地：不做则频道交互范式残缺
- **P2** = 粗糙但可绕行的缺陷与体验
- **P3** = 小项 / 建议 / dev-only

规模粗估：S < 半天；M = 半天~2 天；L > 2 天。

| 优先级 | # | 条目 | 类型 | 来源 | 规模 | 说明 |
|--------|---|------|------|------|------|------|
| P0 | 1 | SSE 修复：compression filter 排除 text/event-stream | 缺陷修复 | #259 / F11 | S | 根因=app.ts 全局 compression 缓冲 SSE 流，生产所有浏览器实时推送全灭。一行级改动，dev/prod 同愈 |
| P0 | 2 | 人审卡片全灭修复：meta object×string 解析错配 | 缺陷修复 | #247 F1 | S | 后端 meta 发对象、前端按 string 解析 → 三种人审卡片 + footer REQ›/PMO› 全渲染为纯文本。是 #250 一切人审交互的前提 |
| P0 | 3 | NEED_INPUT 归属问答：分层匹配 + 候选集排除清单 | 决策落地 | #258 / F2 | M | 子串匹配无精确优先导致问题「不可回答」（绝对路径都解挂不了）；候选集含生产仓需排除清单机制兜底 |
| P1 | 4 | 人审交互统一：三分工 + 死按钮接线 + 历史卡只读化 | 决策落地 | #250（含 F7/F8/F9） | L | 提案卡就地/闸门抽屉/NEED_INPUT 流内；auditor 采纳接线 card-decision；pending 人闸与 in_review 入口三处不一致收敛 |
| P1 | 5 | NEED_INPUT 结构化选项卡 + 顶栏待办 chip + 追问可见性 | 决策落地 | #250 / F4 | M | meta.options[] + 流内选项卡 +「交给 agent 判断」；消除「假承诺 + 状态矛盾 + 追问折叠隐形」 |
| P1 | 6 | agent 消息 Markdown 渲染 + 代码块复制按钮 | 决策落地 | #248 / #246 P0（F17 反证） | M | 复用 MarkdownBody，仅 agent 侧；日报等大量结构化内容目前纯文本直出 |
| P1 | 7 | 消息布局分侧 + 系统播报居中 + mention chip | 决策落地 | #248 / #246 P1 | M | 人右轻气泡 / agent 左文档流，5min 连续合并；人消息内 @mention 渲染 chip |
| P1 | 8 | composer：Esc 关弹框实修 + IME 守卫 + Enter 防连发 | 决策落地 | #248 / F5 | S | Esc 失效是代码级 bug（无 dismiss 状态）；IME 合成 Enter 不发送，中文用户必踩 |
| P1 | 9 | @文件引用：统一@弹框分组 + meta.files + 路由注入 + 预算降级 | 决策落地 | #249 / #257 | L | 路径补全（git ls-files 词表）+ 结构化 meta + WU metadata.fileRefs + prompt 注入段 + 截断播报 |
| P1 | 10 | 顶栏「默认工程」=本地 repo 下拉 + 当前 PMO chip | 决策落地 | #251 / F12 | M | 落 defaultPath 接通归属链；当前下拉数据源是 Admin-only workspaces 接口，非 Admin 恒空 |
| P1 | 11 | 「默认执行机器」正名挪设置区 + 403/孤儿绑定/回显修复 | 决策落地 | #251 / F12 / #259 | M | 术语分家的另一半；已绑定值不回显 Admin 同现（#259 补实） |
| P1 | 12 | publish 回写 channelId + PMO 页「去频道」按钮复活 | 决策落地 | #251 | S | 建 PMO 不预选频道；创建频道表单加可选默认工程并去重双表单 |
| P2 | 13 | 通知铃接后端 notifications API | 缺陷修复 | #251 / F10 | M | 现纯内存消费 SSE atHuman、刷新即丢、恒「暂无通知」；notifications 路由 x-user-id 与登录态脱节一并处理。✅ #274 已完成（e48ba208，local master，待 ship） |
| P2 | 14 | 六条跳转断点处置 | 决策落地 | #251 / F13 | M | 含 PMO 项目页无跳频道入口（反向链路断一档） |
| P2 | 15 | NEED_INPUT 内嵌回复假承诺/状态矛盾清理 | 缺陷修复 | #247 F4 | S | 「已回复」badge 与「等待回复」同屏并存；一屏 5 个相同回复框。与 #5 联动实施。✅ #276 已完成（786a9e45 + eb15049f 评审补漏，local master，待 ship） |
| P2 | 16 | WU 列表统计修复：总数恒 0、pending 计入「待人工」 | 缺陷修复 | #247 F6 | S | 列表 3 条显示总数 0；pending 应单列「待确认」 |
| P2 | 17 | PMO description 落错字段 + progress 口径矛盾 | 缺陷修复 | #247 F13 | S | 需求描述存进 requirement、description 恒 null 显示「无描述」；0/1 WU 阻塞却 progress=100。✅ #282 已完成（efc31476，local master，待 ship） |
| P2 | 18 | 非 Admin 403 降级 UX | 缺陷修复 | #247 F14 | S | 左栏 Agents 恒「加载中…」+ console 403 轮询刷屏；应渲染「无权限」。✅ #283 已完成（6bfad0f2，local master，待 ship） |
| P2 | 19 | 线程回复位置不稳定 | 缺陷修复 | #247 F17 | M | 轮询增量到达时线程回复以主消息 appended 流尾，刷新后归并线程——同一消息两种位置 |
| P2 | 20 | 人审卡片按钮一次性锁存核查 + 高危操作二次确认 | 打磨 | #246 P2 | S | 逐个卡片核查点击到状态回流间的防重复；retract/退役类接 acknowledge→confirm 两步。✅ #288 已完成（7f9bd618，local master，待 ship；需求文档卡经核查 #278 已只读化无按钮，无需锁存） |
| P2 | 21 | observed-top 滚动台账 + ResizeObserver 跟随 + 回到底部按钮 | 决策落地 | #248 / #246 P1 | M | 程序写 scrollTop 必记账，偏离才算读者滚动；卡片展开撑高时跟随。从 #246 P1 降到 P2：顺滑度优化，不阻塞链路。✅ #289 已完成（f7033831，local master） |
| P3 | 22 | 加载更早消息改行锚点补偿 | 打磨 | #246 P2 | S | 高度差补偿法不抗加载期间高度变化；换行锚点 + 位移补偿。✅ #290 已完成（local master；回写：锚点身份复用既有 `data-message-id` 属性，未新增 `data-mid`） |
| P3 | 23 | dev 深链/刷新 404 修复 | 缺陷修复 | #247 F3 / #259 | S | vite base=/dev/ × Router 无 basename；生产已通过，dev-only。✅ #291 已完成（0606ba71，local master；dev base 经 VITE_BASE 注入，非硬编码 /dev/） |
| P3 | 24 | WU 抽屉/详情负责人显示原始 UUID | 缺陷修复 | #247 F15 | S | 应解析为角色名。✅ #290 已完成（local master；`useAssigneeDisplay` 共享 hook + `AssigneeLabel`，详情页/抽屉/REQ 链路三处收敛） |
| P3 | 25 | 「空成员」语义矛盾 + 发起讨论频道选项单一 | 打磨 | #247 F16 | S | 警告「没有可响应成员」vs 成员面板「空=所有 Agent 可见」互相打架。✅ #290 已完成（local master；回写：前端无过滤，选项单一是 PMOPage 挂载期 channels 滞后所致，改为对话框打开时自取 `channelApi.list()`） |
| P3 | 26 | 转为任务对话框标题预填 | 打磨 | #247 F18 | S | 从消息原文派生默认标题。✅ #292 已完成（fd9ede94，local master） |
| P3 | 27 | 频道恢复阅读位置 + 跟随阈值 80→24 收紧 | 打磨 | #246 P3 | S | 切频道恢复上次位置（anchorKey+anchorTop）；80px 在短消息流里≈永远跟随。✅ #290 已完成（local master；存档走 localStorage `studio-channel-reading-pos:<channelId>`） |

依赖关系备注：#2 是 #4/#5 的前置（卡片先能渲染才谈交互统一）；#1/#2/#3 互不依赖，可并行。

## 三、明确排除项（不进清单）

- dsh 的 thinking 折叠行 / turn 级状态行：依赖 agent 过程数据进频道，属未来能力（2026-08-18 决策 D1 的频道 live 状态条已覆盖近期诉求）
- dsh 不建议照搬的部分：WS 下行 + 投影订阅、cordis/slot 装配、自研增量 Markdown parser、草稿机——架构级工程，与频道消息粒度不匹配
- dsh 模型重试行、消息分支（forkAt）：单人会话 console 形态，与多人多 agent 异步频道模型不匹配
- 未读计数持久化、频道消息搜索/编辑/删除：地图 #245 Out of scope，独立功能块各自够开一张图
- 外部 IM 通道（Discord/钉钉/飞书）交互一致性：地图 #245 Out of scope

## 四、后续

本清单交付给后续实现 effort 排期；地图 #245 随本定稿散场。实现时如发现清单条目与实际代码漂移，以代码为准并回写修订本文档。
