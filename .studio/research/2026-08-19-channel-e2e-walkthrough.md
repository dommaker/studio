# 研究：频道全链路 e2e 走查（Web 频道人审/跳转/绑定呈现）

- 票：#247（wayfinder 地图 #245 子票）
- 日期：2026-08-19
- 走查对象：studio dev 环境（仓库 `/root/projects/studio` master；dev 数据根 `~/.studio-dev/`，与生产 `~/.studio/` 隔离）
- 走查方式：Playwright（Chromium）实操 UI + curl 直打 API 验证 + 关键路径代码确认（一手来源，标注实测/构造）
- 环境实况：Web = vite dev `:13000`（VITE_BASE=`/dev/`）→ 代理 API `:13001`（dev，STUDIO_HOME=`~/.studio-dev`，但 `apps/api/.env` 带 `NODE_ENV=production`，故 Lurk Wall/权限中间件全部生效）；`:13101` 是**生产 API**（studio-prod），本走查未触碰
- 上一个会话已留 15 张截图（shots/00–14），本会话全部重读提取发现，并补走缺口（shots/15–26）

## 0. 走查覆盖矩阵

| 票要求路径 | 覆盖 | 证据 |
|---|---|---|
| 1. 建 PMO → 绑定工程（多仓库）→ 发起需求讨论 | ✅ 实测 | 00–04 |
| 2. @角色（弹框/键盘/Esc）、发消息、线程回复、转为任务 | ✅ 实测 | 06、07、10、20 + 本会话 live 复验 |
| 3. NEED_INPUT 挂起 → 内嵌回复 → 恢复 | ✅ 实测（含三轮真实回复） | 08、11、18、19 |
| 4. 人审流：pending / in_review 通过·拒绝 / analysis 接力 / 三种卡片 | ✅ 卡片实测+根因；pending/in_review/analysis 用 API 构造状态后 UI 实测 | 12、21、22、23 |
| 5. 跳转链路双向 | ✅ 除「footer PMO ›」被 F1 阻断无法实测 | 15、16、17、24、26 |
| 6. 频道绑定呈现（顶栏默认工程、绑定 PMO 可见性） | ✅ 实测 + 代码确认 | 09、25 |

构造数据说明：dev 无真实 agent loop。F1 的三张卡片消息为上会话经 API 构造（meta 格式与生产 `createCardMessage` 一致）；in_review/pending/analysis 状态由本会话 `POST /workunits/:id/status` 构造后走 UI；通知数据为手工 append `notifications.jsonl`（仅在验证「后端有数据、铃铛拿不到」时使用）。其余全部真实 UI 操作。

---

## 发现清单

### 阻塞

**F1. 频道卡片全灭：后端 meta 发对象、前端按 string 解析，所有人审卡片渲染为纯文本**
- 现象：requirements_doc / knowledge_confirm / auditor_suggestion 三种人审卡片消息在频道里只显示 content 纯文本，无任何按钮——「三种死按钮卡片」的实际表现是**按钮根本不存在**。影响面不止卡片：`ChannelMessageItem` 的 footer `REQ ›` / `PMO ›` 按钮同样依赖 `parseMeta`，一并消失（WU › 用顶层 `workUnitId` 字段，幸存）。
- 根因（代码一手确认）：`apps/api/src/modules/channels/channel-message.service.ts:48` `shapeMessageData` 把 meta `JSON.parse` 成对象随 REST/SSE 下发；前端 `apps/web/src/components/channel/ChannelMessageItem.tsx:235` `parseMeta(meta?: string)` 对对象执行 `JSON.parse` 抛异常被 catch 成 `{}` → `cardType` 丢失 →  fallback 纯文本。前端类型声明 `apps/web/src/api/channel.ts:12` 也是 `meta?: string`。
- 复现/证据：`curl /api/v1/channels/<id>/messages` 响应中 meta 为 object（本会话实测输出）；shots/12-cards-render-as-plain-text.png；本会话登录后 live 复验三条卡片消息仍纯文本。
- 严重度：**阻塞**（频道人审卡片体系端到端不可用）
- 影响票：**喂给 #250**（人审交互统一的前提——卡片先要能渲染）

**F2. NEED_INPUT 工程归属问题「不可回答」：子串匹配无精确优先，WU 永久循环挂起**
- 现象：WU 70251b9a 挂起问「这个任务要修改哪个工程？」。三轮真实回复全部重新挂起：①「e2e-走查：确认继续…」→ 无匹配；②「studio」→ 命中 studio / studio-config / studio-prod 三个；③**完整绝对路径「/root/projects/studio」→ 仍命中三个**（`/root/projects/studio` 是 `/root/projects/studio-config`、`/root/projects/studio-prod` 的前缀，子串匹配全中）。对 studio 这个工程，该问题没有任何答案能解挂。
- 根因：`apps/api/src/modules/projects/project-discovery.service.ts:70-76` `search()` 只做 `name.includes(q) || path.includes(q)`，无精确匹配/边界匹配优先；`waiting-input.ts:324` 只有 `candidates.length === 1` 才解挂，否则循环追问。
- 证据：shots/19（三轮问答全在）；`GET /workunits/70251b9a` 实测 status=blocked、waitingForInput=true（三次回答后不变）；messages.jsonl 逐条核对。
- 附带：候选列表把**生产仓 `studio-prod`（/root/projects/studio-prod）和归档 `harness.bak`** 列为可选工程（shots/19）——dev 环境的挂起问答里诱导人把任务绑到生产仓。
- 严重度：**阻塞**
- 影响票：**新问题，需开票**（后端匹配逻辑 + 工程发现范围/生产隔离）；交互环路断裂事实同步**喂给 #250**

**F3. dev 环境深链/刷新全灭：入口 404、直进 404、刷新 404**
- 现象：① `http://localhost:13000/dev/`（start.sh 广告的唯一入口）直接渲染路由 404（shots/02、15）；② 直接访问/刷新 `/channels/:id` → vite HTTP 404（本会话实测，`page.reload()` 后页面死掉）；③ `/dev/channels/:id` → SPA 加载但路由 404（shots/15）。唯一可用路径 = 进 `/dev/`（本身是 404 页）→ 点侧边栏客户端导航。通知/WU 详情里所有 `/channels/:id` 链接落地后一刷新即死。
- 根因方向：vite `base=/dev/`（apps/web/vite.config.ts:11 读 VITE_BASE）而 React Router 无 basename，两边各认各的路径。
- 证据：shots/02-dev-base-404.png、shots/15-dev-base-deep-link-404.png；本会话 reload 实测。
- 严重度：**阻塞**（dev 环境；生产由 API 静态托管，未验证，需另验）
- 影响票：**喂给 #251**（页面跳转链路的基础设施）

### 粗糙

**F4. NEED_INPUT 内嵌回复「假承诺 + 状态矛盾 + 追问隐形」**
- 现象：内嵌回复发送后立刻显示「✓ 已回复，WorkUnit 将继续执行」，但 WU 因 F2 重新挂起后，同一条消息上「等待回复」badge 与「✓ 已回复」**同屏并存**（shots/18）；agent 的追问作为线程回复被折叠进「▸ N 条回复」，主流量不可见（shots/19）；展开线程后**每条**关联消息都挂「等待回复」badge + 各带一个内嵌回复框（一屏 5 个相同回复框）。
- 证据：shots/11-embedded-reply-false-promise.png、18、19；本会话真实回复两轮实测。
- 严重度：粗糙（底层挂起是真的，UI 表达全错）
- 影响票：**喂给 #250**

**F5. mention 弹框 Esc 失效（代码级确认）**
- 现象：@ 弹框打开后按 Esc 不关（底部提示却写着「Esc 取消」）。
- 根因：`apps/web/src/components/channel/ChannelInput.tsx:94-98` Escape 分支只 `setMentionIdx(0)`，弹框的显示条件是 `filteredAgents.length > 0`（由输入框里残留的 @query 推导），没有任何 dismiss 状态——Esc 永远关不掉。
- 证据：shots/07-esc-not-closing.png；本会话 live 复验（Esc 后 `.mc-mention-popup` 仍在 DOM 且可见）。
- 严重度：粗糙
- 影响票：**新问题，需开票**

**F6. WU 列表统计坏：「总数」恒 0；pending 计入「待人工」**
- 现象：列表有 3 条 WU 时统计条显示「总数 0 · 待分配 2」（shots/13）；构造 pending WU 后统计为「待人工 1」而非待确认（shots/23）。
- 证据：shots/13-wu-list-total-zero.png、23；本会话 live 复验（0 总数 + 3 行列表同屏）。
- 严重度：粗糙
- 影响票：**新问题，需开票**

**F7. pending 人闸 UI 死锁：「待确认」tab 只列不放行**
- 现象：#126 人闸 pending WU 的确认按钮只存在于频道抽屉（`WorkUnitDrawer.tsx` `handleConfirmPending`）；WU 列表「待确认」tab 的行展开态**没有任何操作按钮**（shots/23），WU 详情页也没有。若 pending WU 没有被任何频道消息引用（抽屉唯一入口是消息 footer 的 WU ›），UI 上无任何路径可以放行它（只能 curl `POST /:id/status`）。
- 证据：shots/23-pending-row.png；`WorkUnitListPage.tsx` 全文无 pending 处理（grep 确认）。
- 严重度：粗糙
- 影响票：**喂给 #250**

**F8. in_review 通过/拒绝入口三处不一致：列表行有、抽屉有、详情页没有**
- 现象：WU 列表行展开态有「通过/拒绝」（拒绝带原因弹窗，实测 in_review→active、in_review→done 均正确，shots/21）；频道抽屉有；**WU 详情页（/workunits/:id）只有状态展示，无任何审查操作**——而详情页恰是「↗ 新页面打开」的落点。
- 证据：shots/21-wu-list-review-buttons.png；本会话 WU 详情页快照（in_review 状态无按钮）。
- 严重度：粗糙
- 影响票：**喂给 #250**（人审交互统一的直接素材）

**F9. analysis 接力确认弹窗正常，但入口同样只有列表行/抽屉**
- 现象：构造 analysis WU in_review 后，列表行「通过」弹出「确认分析结论」弹窗（待决问题清单可编辑 + 默认执行角色下拉），渲染与交互正常（shots/22）。与 F8 同源：详情页无此入口。
- 证据：shots/22-analysis-approve-modal.png（构造数据实测，弹窗内容为占位清单）。
- 严重度：粗糙（功能在、入口散）
- 影响票：**喂给 #250**

**F10. 通知铃与后端通知系统完全脱节**
- 现象：铃铛下拉恒「暂无通知」（shots/26），尽管后端 `logs/notifications.jsonl` 有数据（auditor 等模块会写入）。代码确认：`NotificationBell.tsx:47-85` 不调用任何通知 API，只消费页面在线期间的 SSE `channel.message_sent` 且 `meta.atHuman` 事件，**纯内存、刷新即丢**；`meta.atHuman` 又受 F1 同源的 meta 形态问题威胁。同时 notifications 路由按 `x-user-id` header 取用户（缺省 `default-user`），与登录态无关（`modules/notifications/routes.ts:21`）。
- 后果：票要求的「通知 → 频道」跳转链路（`openNotification` 代码存在）在实际运行中永远无米下锅。
- 证据：shots/26-notification-bell-empty.png；代码两处；本会话 append 通知数据后铃铛仍空（符合代码预期）。
- 严重度：粗糙
- 影响票：**喂给 #251**

**F11. SSE 恒「未连接」，实时推送全灭（根因未定，疑 dev 环境）**
- 现象：两个会话全部截图顶栏恒「未连接」。本会话实测：页面内 `new EventSource('/api/v1/events/stream')` 永远停在 CONNECTING；`fetch` 该端点 4s 收不到响应头；CDP 网络栈确认请求已发出、无响应、无失败回调。而同一时刻 `curl`（直连 13001、经 vite 代理 13000、带浏览器同款头）**全部秒回 SSE 首帧**。重启浏览器后复现依旧。
- 影响：频道新消息只靠 10s 轮询；F10 通知铃的事件源断供。
- 证据：本会话 CDP/evaluate/curl 对照记录（命令可重放）；shots/00–26 顶栏一致。
- 严重度：粗糙（curl 正常 → 疑似 vite 代理与 Chromium 的交互问题，dev 特有；**若生产同现则升阻塞**，需生产复验）
- 影响票：**新问题，需开票**

**F12. 顶栏「默认工程」对非 Admin 用户恒空，且语义张冠李戴**
- 现象：频道顶栏下拉只有「默认工程：无」一项（shots/09）；但频道实际已绑定 workspace `ws_1787121654275_w9fwfyx`（channel config.json 一手数据，上会话绑定后顶栏曾显示「VPS」）。代码确认：`ChannelWorkspaceSetting.tsx` 数据源是 `workspaceApi.list()` = `GET /api/v1/workspaces`（**Admin-only**，本会话 User 角色 curl 实测 403）→ 非 Admin 恒空，已绑定值也显示「无」。且「默认工程」实际绑的是远程 Workspace，与 PMO/WU 用的本地工程发现（`/projects/discover`，6 个本地仓）是两套概念。
- 证据：shots/09-default-project-dropdown-empty.png；config.json；curl 403；代码。
- 严重度：粗糙（Admin 视角未测——dev 无 Admin 账号）
- 影响票：**喂给 #251**

**F13. PMO 项目页：无跳频道入口；「无描述」；progress=100 与 0/1 WU 矛盾**
- 现象：① 项目页全文无任何到频道的链接（需求讨论在频道进行，页面只有「讨论」阶段标签，非链接）——反向链路断一档（WU 详情页有 `#研发` 链接可回频道，实测正常）；② 创建时填的「需求描述」存入 `requirement` 字段，`description` 恒 null（curl `GET /pmo/project?id=` 一手确认），列表/详情头部恒显示「无描述」（shots/03、24）；③ 同屏「进度管道 0/1 WU 完成 · 0%」与「项目进展 100%」（唯一 WU 处于阻塞；API `progress: 100` 一手确认）。
- 证据：shots/24-pmo-project-no-channel-link.png、03；PMO API 响应原文。
- 严重度：粗糙
- 影响票：跳转缺失**喂给 #251**；description 落错字段 + progress 口径矛盾 = **新问题，需开票**

**F14. 非 Admin 用户的权限降级 UX：左栏 Agents 恒「加载中…」+ console 403 刷屏**
- 现象：User 角色登录后，频道左栏 Agents 区永远「加载中…」（`/api/v1/workspaces/runtimes` 403）；console 被 `/monitoring/agents`、`/monitoring/overhead`、`/workspaces/runtimes` 的 403 轮询刷屏（一会话 40+ 条）。
- 证据：本会话 console 导出（Playwright console log）；shots/25 左下角。
- 严重度：粗糙
- 影响票：**新问题，需开票**（403 场景应渲染「无权限」而非永远加载）

**F15. WU 抽屉「负责人」显示原始 UUID**
- 现象：抽屉负责人 `@d6a32872-5fa4-417a-…`（profile UUID 原文），非角色名；WU 详情页归属区同样 `@d6a32872` 并自注「实例不在当前运行列表，无法定位角色」。
- 证据：shots/16-wu-drawer-from-message.png。
- 严重度：粗糙
- 影响票：**新问题，需开票**（小）

**F16. 发起讨论警告与成员面板语义矛盾**
- 现象：发起需求讨论时警告「该频道没有可响应的 Agent 成员，发起后需求可能无人认领」（shots/04）；但成员面板写「空 = 所有 Agent 可见」（shots/25）。两个「空成员」语义互相打架。另：发起讨论对话框的频道选择只有「#系统」一个选项。
- 证据：shots/04-start-discussion-dialog.png、25-member-manager.png。
- 严重度：建议
- 影响票：**新问题，需开票**（小）

### 挑战已决项

**F17. 频道消息 raw Markdown 不渲染 + 线程回复位置不稳定 —— 对照 #248 已决项**
- 现象：agent 消息（DailyReflection 日报等大量 `##`/列表/代码内容）以纯文本直出（shots/05）；本会话观察到线程回复经轮询增量到达时以**主消息** appended 在流尾（shots/19、25 中 16:57「/root/projects/studio」），刷新后又归并进折叠线程——同一条消息两种位置。
- 证据：shots/05-channel-raw-markdown.png、19、25。
- 严重度：粗糙
- 影响票：**挑战 #248 已决项**（#248 已关闭；若其结论含「纯文本可接受」，此处提供反证素材；线程位置问题 #248 未覆盖，属新缺口）

### 建议

**F18. 转为任务对话框不预填标题**
- 现象：⊕ 对话框顶部展示消息原文，但「标题」输入框留空需手打（shots/20）。创建链路本身正常（实测 WU 59541ca9 创建成功、消息回填 workUnitId、REQ-0003 chip 联动出现并标 done）。
- 证据：shots/20-convert-to-task-dialog.png。
- 严重度：建议
- 影响票：**新问题，需开票**（小）

---

## 正面清单（实测正常的链路）

- PMO 创建（多仓库勾选交付腿）→ PMO-1 落库（01、03）
- 发起需求讨论 → 频道消息 + REQ-0001 创建（04、05）
- @mention 弹框出现、↑↓/Enter 选择插入（06，Esc 除外见 F5）
- 线程回复/展开/收起、引用块（10）
- NEED_INPUT 挂起 badge + 内嵌回复框出现、回复能触发后端 resume（08，恢复失败是 F2 的事）
- 转为任务全链路（20）
- 消息 footer WU › → 抽屉、抽屉内 REQ-0001 › → REQ 全链路抽屉、抽屉链回 WU（16、17）
- WU 详情页归属区 `#研发` → 频道跳转（本会话实测）
- in_review 通过（→done）/拒绝（带原因 →active）（21）
- analysis 确认弹窗（22）
- 成员管理面板（添加 Agent/创建 Agent 入口）（25）
- 频道顶栏 REQ chips 随 WU 状态联动（REQ-0003 done）（25）

## 残留缺口（未覆盖）

1. 消息 footer 的 `PMO ›` 按钮实测——被 F1 阻断（依赖 parseMeta），需 F1 修复后补测。
2. 真实 agent loop 下的 WU 认领/执行/NEED_INPUT 真实触发——dev 无 loop 运行，本次挂起/审查状态均为 API 构造。
3. F11 SSE 断连根因未定位（curl 正常、Chromium 挂起），需在生产静态托管环境复验定级。
4. Admin 视角的「默认工程」下拉、监控页（dev 无 Admin 账号）。
5. 生产环境（studio-prod `:13101`）按纪律未触碰，所有结论仅限 dev。

## 附录：本会话构造的 dev 数据（清理用）

- 用户 `e2e-walkthrough@local.dev`（User 角色）
- WU `59541ca9…`（e2e-走查-转为任务验证，已 done）、`e5653ace…`（e2e-走查-pending人闸验证，pending）、`09cd2207…`（analysis，被推到 in_review 后取消确认，仍 in_review）、`70251b9a…`（仍 blocked，因 F2 无法解挂）
- REQ-0003（转为任务联动创建）
- `~/.studio-dev/logs/notifications.jsonl` 追加的 `notif-e2e-walkthrough-001`
- 频道 #研发 内 e2e 前缀消息若干（含三轮 NEED_INPUT 回复）
