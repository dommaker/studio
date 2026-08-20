# 研究：deepseek-harness web 聊天交互可借鉴点盘点

- 票：#246（wayfinder 地图 #245 子票）
- 日期：2026-08-19
- 调研对象：`/root/projects/deepseek-harness`（下称 dsh）web 前端
- 对照对象：studio 频道前端 `apps/web/src/components/channel/` + `apps/web/src/pages/ChannelDetailPage.tsx` + `apps/web/src/hooks/useChannelEvents.ts`

## 0. dsh 前端架构速览

dsh web 是一个 React 18 单页应用，入口极薄（`apps/web/src/main.ts` 只有 10 行），全部 UI 在 `packages/client/` 下的插件包中，按 cordis 槽位（slot）组装：

- `ui-conversation`：会话视图主体——消息流（chat/）、输入框机（input/）、骨架（skeleton/，含 InputBar、ApprovalPanel）
- `ui-input-trigger`：`/`、`@` 触发的补全弹框（MenuView）
- `ui-commands`：popupSelect 弹框（PopupSelectView，持焦点的选择器）
- `ui-user-questions`：ask-user 问答接管输入区（QuestionComposer、PlanReviewPanel）
- `ui-attachment`：图片附件（AttachmentRail、DropOverlay、ImageLightbox、MessageImage）
- `ui-primitives`：MarkdownText、MessageText、DisclosureRow、Menu、RiskConfirmation 等基础件
- `client/connection`：传输层（HTTP 上行 + WebSocket 下行）
- `ui-tool`：工具调用行（ToolCallTree + 专用 toolviews：bash/read/search/todo/web...）

委托人称其"流畅顺滑"的两个点名细节——思考时滚动加载、页面一直展示最新消息——核心实现都在 `ui-conversation/src/client/chat/ChatView.tsx`，下文 §4、§5 详述。

---

## 1. 消息布局：人/agent 分侧 + 引用 chip

**dsh 做法**：用户消息右对齐气泡（`UserStyleBubble`，`css.userRow`/`css.bubble`），agent 回复左对齐无气泡的文档流。用户气泡内的 `@name`、`/name` 纯文本 token 经正则扫描渲染为带类型的引用 chip（`refChip`，区分 subagent/skill 两种 `data-ref-chip`）。气泡下方有时钟 + 复制 IconActions（hover 出现）。

- 依据：`packages/client/ui-conversation/src/client/chat/MessageItem.tsx`（`UserStyleBubble` L179-205、`projectUserText` L157-176）、`chat/MessageIconActions.tsx`
- assistant 侧：`chat/AssistantMarkdown.tsx` + `AssistantNodeView.tsx`

**studio 现状**：`ChannelMessageItem.tsx:98` 统一 `mc-msg` 左对齐纯文本行，人/agent 仅靠头像和 `@名字` 颜色区分；消息正文里的 `@mention` 是纯文本无 chip。

**借鉴点**：
- (a) 人/agent 分侧（人右气泡、agent 左文档流），一眼区分"我说的"与"agent 说的"。
- (b) 发送后的消息里 `@AgentName` 渲染为 chip，与输入框 mention 视觉闭环。
- (c) hover 才出现的轻量行内动作（复制/时钟），studio 现在是常驻的 ↩/⊕ 按钮。

## 2. Markdown / 代码块渲染

**dsh 做法**：assistant 文本块走 `MarkdownText`（GFM + KaTeX，禁 raw HTML/相对链接/不安全协议，http(s) 图片直渲）。流式期间的渲染经济性是关键设计：**增量解析器把除末尾两个 block 外的已稳定 block 冻结为缓存 React 元素，每个 chunk 只重解析尾部**；冻结块跨边界保持 source-offset key，React 复用而非重挂载。流式时代码 fence 与 TeX 先按纯文本渲染，高亮和 KaTeX 在 finalize 时一次性换上。代码块带复制按钮（`codeLabels`）。settled 渲染额外把 inline-code 中识别为真实文件的 token 链成可点链接（`fileMentions`，只挂 settled，避免流式冻结元素烤入过期 handler）。

- 依据：`packages/client/ui-primitives/src/markdown/MarkdownText.tsx`（头注释 L1-11、`StreamingRenderer` L59-138）、`markdown/incremental.ts`、`markdown/render.tsx`

**studio 现状**：`ChannelMessageItem.tsx:142` `<div className="mc-msg-body">{message.content}</div>` 纯文本，无任何 Markdown/代码块渲染。

**借鉴点**：
- (a) 频道消息（至少 agent 消息）接 Markdown 渲染——agent 输出大量列表/代码/标题，纯文本严重损失可读性。这是**收益最大的一条**。
- (b) 代码块复制按钮。
- (c) 若未来做流式正文，"冻结头部 + 只重解析尾部"的增量渲染策略可直接搬思路（不必搬 dsh 的自研 parser，可用 remark 生态按 block 边界分段缓存）。

## 3. thinking（推理过程）展示

**dsh 做法**：reasoning 块渲染为 "Think" 折叠行（DisclosureRow）：**运行中**摘要是推理文本的**最后一行**（latestLine），且摘要区横向自动跟随到末尾（`data-follow-end`，经 3 帧节流的 scrollLeft 对齐）；**结束后**摘要切换为**首行**（firstLine）。点击行展开全文，缩进灰字。屏幕阅读器有 `visuallyHidden` 的 running 状态播报。

- 依据：`packages/client/ui-conversation/src/client/chat/ReasoningRow.tsx`（`latestLine`/`firstLine` L9-18、摘要滚动 L31-38）、`chat/use-throttled-visual-update.ts`（3 帧 rAF 合并非关键视觉更新）

**studio 现状**：频道无 thinking 概念；agent 的中间过程不进频道（或只能以普通消息形式出现）。

**借鉴点**：
- (a) "运行中看最新一行、结束后看首行"的折叠摘要形态，适合 studio 未来展示 agent 执行中的思考/进度。
- (b) `useThrottledVisualUpdate` 这种"非关键视觉更新按帧节流"的小工具，任何流式 UI 都用得上。

## 4. 流式渲染与传输

**dsh 做法**：传输层是 **HTTP 上行 + WebSocket 下行**（不是 SSE）：`events.mux` 与 `events.host` 两条下行流各一条 WS，帧过 zod schema 校验，坏帧丢弃并记日志。事件驱动的是**会话投影（projection）**，前端 store 按 node key 组织；渲染侧是**稳定 keyed 父列表 + 每行一个 ChatNodeSeat 各自订阅单个 node key**——"Assistant deltas and Tool lifecycle updates replace only their own row without remounting it"（ChatView.tsx 头注释）。即增量只替换自己那一行，列表顺序仅在行进出时变化。

- 依据：`packages/client/connection/src/client/web-api-client.ts`（L1、L12、L23/31、L42-59）、`packages/client/connection/src/websocket-downlink.ts`（host 侧 WS 承载）、`packages/client/ui-conversation/src/client/chat/ChatView.tsx` L1-13、`chat/ChatNodeSeat.tsx`

**studio 现状**：`useChannelEvents.ts` SSE 推送的是**完整消息**（`channel.message_sent` 事件带整条 message，前端去重后 append），外加 10s 轮询兜底（`useChannelEvents.ts:71`）。无 token 级增量——因为频道消息是"完成才发"的粒度。

**借鉴点**：
- (a) studio 频道消息粒度是整条消息，当前 SSE+去重够用；**不需要**为频道引入 token 级流式。真正的对照是：如果未来频道要展示 agent "正在输入/正在执行"的进行中状态，dsh 的"投影 + 按 key 订阅单行替换"模式比"整条消息刷新"省渲染。
- (b) 帧 schema 校验 + 坏帧丢弃记日志（`web-api-client.ts` L59），比 studio 前端隐式信任事件 payload 健壮。
- (c) 传输选型差异记录：dsh 选 WS 是因为它要双向多路复用 RPC；studio 单向推送用 SSE 没问题，不构成借鉴项。

## 5. 自动滚动跟随最新消息（委托人点名细节一）

**dsh 做法**（全部在 `ChatView.tsx`，约 140 行滚动逻辑）：

1. **跟随阈值 24px**（`FOLLOW_THRESHOLD` L24）判定"钉在底部"。
2. **读者输入归属判定用 observed-top 台账**（L274-281）：每次程序写 scrollTop 都同步记录到 `observedTopRef`；scroll 事件里实际位置偏离台账才算"读者滚的"。滚轮/触摸/滚动条/键盘全覆盖，且不需要按设备挂监听。浏览器 shrink-clamp 和延迟落地的程序滚动都精确落在台账上，不会误判所有权。
3. **只在流尖端签名移动时跟随**（`followSig` L192、L255-261）：open 状态/首条 seq/末条 key/行数/running/steering 组成的签名变了才滚——**不会**因为 atBottom 状态变化引发的 chrome 重渲染把惯性滚动吸附到底。
4. **自己发的消息强制滚底**（`appendedUser` L253）——发送动作在 composer，但检测在列表侧（新尾部节点 kind === 'user'）。
5. **ResizeObserver 监听列高与 composer 高度**（L331-341）：流式增长、工具行展开导致的列高变化，仅在读者被钉住时跟随。
6. **离底时浮出"回到底部"按钮**（L408-423）。
7. **会话重开恢复滚动位置**（L211-232）：`chatScroll.read()/save()` 存 `anchorKey + anchorTop`（行身份 + 行相对位置，抗重排）；钉底时存 null，重挂载直接到底。

**studio 现状**：`ChannelDetailPage.tsx:157-181`，阈值 80px，`nearBottom || last?.authorType === 'human'` 时跟随；无前述 3/5/6/7。

**借鉴点**：
- (a) **observed-top 台账**：studio 目前 `nearBottom` 判定在 `useLayoutEffect` 里对每条新消息做几何计算，无法区分"用户向上滚了"与"内容长高把位置顶离底部"。台账法是 dsh 滚动不"跳"的核心，代码量小（一个 ref + 每次写 scrollTop 记一笔），可直接搬。
- (b) ResizeObserver 跟随（列高变化场景：卡片展开、图片加载完成撑高消息——studio 卡片族展开时目前不会跟随）。
- (c) "回到底部"浮动按钮。
- (d) 阈值从 80px 收紧到 24px 量级（80px 在短消息流里几乎等于"永远跟随"，容易打断阅读上文的人）。
- (e) 切换频道后恢复上次阅读位置（studio 目前 `scrollStateRef.initial` 每次切频道都强制回底）。

## 6. 加载更早消息

**dsh 做法**：顶部 "Load older" 按钮；点击时用**四点 hit-test**（`document.elementsFromPoint` 在视口 1/32/1/2/底部附近探测）找到当前可见的稳定行，记下 `{key, top}` 锚点；prepend 落地后按该行的位移差恢复视口（L237-249、L349-363）。请求失败/为空时清锚点（L345-347）。锚点 key 用 `data-chat-anchor-key`（节点/调用身份），与边界跨组的 key 无关，抗 key 漂移。

**studio 现状**：`ChannelDetailPage.tsx:148-165` `handleLoadMore` 记录 `prevHeight`，prepend 后按 scrollHeight 差值补偿——思路相同。

**借鉴点**：
- (a) 高度差补偿法对"composer 高度在请求期间变化"或"有行在加载后改变高度"不抗；dsh 的**行锚点 + 行位移补偿**更精确。studio 若有图片/卡片异步撑高，值得换。
- (b) hit-test 找锚点比"取第一可见行"在极端布局下更稳，但 studio 用 querySelector 找第一可见行已够——优先级低。

## 7. 输入框：mention/补全弹框样式与键盘交互

**dsh 有两种弹框形态**，按交互深度分工：

**形态一：combobox 补全菜单**（`/`、`@` 触发）——**焦点永不离开 textarea**：
- `role="listbox"` + `aria-activedescendant` 虚拟高亮；行用 `onMouseDown + preventDefault` 选取（防 blur，combobox 标准手法）
- ↑↓ 移动高亮后 JS `scrollIntoView({block:'nearest'})`（焦点不动，浏览器不会自动滚）
- 弹框**底部锚定在 composer 上方**，最大高度按"composer 上方剩余空间"实时 clamp（`useAnchoredMaxHeight`），设计上限 320px
- 分组渲染（多来源候选各带标题行），未就绪来源显示 loading 行
- dismiss 判定：**点弹框外且 composer 卡外才关**（点 textarea/底栏不关）
- 依据：`packages/client/ui-input-trigger/src/client/MenuView.tsx`（L46-65、L100-103）、`controller.ts`

**形态二：popupSelect 持焦点选择器**（需要搜索/确认的深层选择）：
- 内嵌搜索框接管焦点，本地过滤；Enter 选、↑↓ 移、**Esc 关闭并把焦点还给 composer**；←→ 保留搜索框原生光标
- 任意外部 pointerdown（capture 相）即关
- 危险项接 `RiskConfirmation` 二次确认（勾选 acknowledge → confirm）
- 依据：`packages/client/ui-commands/src/client/PopupSelectView.tsx`（L52-75、L82-104、L160-173）

**键盘分层**（InputBar）：Esc 先 `dismissPopup()` 关 overlay，再进 machine 仲裁；IME 合成中的 Enter 不发送（`isComposing || keyCode === 229`，Safari 的 compositionend 后晚到 keydown 用 10ms 延迟清标记兜底）；Enter 长按 `e.repeat` 不连发。

- 依据：`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx`（L109-119 IME、L283-296 Esc、L323 repeat）

**studio 现状**：`ChannelInput.tsx`——↑↓ 循环选择、Enter/Tab 插入；**Esc 只 `setMentionIdx(0)` 不关闭弹框**（L94-98）；弹框无分组、无高亮行滚动跟随、无 IME 守卫、无 aria 属性；`mc-mention-popup` 固定样式。

**借鉴点**：
- (a) **Esc 关闭弹框**（分层：先关弹框再轮到其他 Esc 语义）——studio 现在是已知 bug 级差距。
- (b) ↑↓ 移动时高亮行 `scrollIntoView({block:'nearest'})`。
- (c) IME 合成守卫（中文输入选词的 Enter 不发送消息）——studio 完全没有，中文用户必踩。
- (d) combobox 模式本身（焦点留 textarea + mousedown 选取）studio 已是这个形态（`onMouseDown preventDefault` L159），保持即可；补 `aria-activedescendant`/`role="listbox"` 无障碍属性。
- (e) 弹框最大高度按可用空间 clamp，而非固定像素。
- (f) Enter 长按防连发（`e.repeat` 检查）。

## 8. 文件/资源引用

**dsh 做法**：
- 消息内：用户消息图片块渲染 `ImageGallery`（连续图片合并成一行平铺，流式追加扩组不重挂载，key 用组首块 index）；assistant Markdown 里 inline-code 识别为真实文件的 token 变可点链接
- composer：`AttachmentRail` 缩略图轨（点开 Lightbox、可移除）、**整页拖拽**投图（document 级 dragenter/leave 计数 + DropOverlay 全页遮罩）、粘贴图片直入、大小/数量/总量限额**整批拒绝**并立即 Toast（不合格批次不进轨，避免提交时才回滚）
- 依据：`packages/client/ui-attachment/src/`（AttachmentRail.tsx、DropOverlay.tsx、ImageLightbox.tsx、MessageImage.tsx）、`ui-conversation/src/client/skeleton/InputBar.tsx`（intakeImages L424-449、整页拖拽 L458-506）、`ui-primitives/src/markdown/render.tsx`（fileMentions）

**studio 现状**：频道无文件引用、无附件。

**借鉴点**：
- (a) 若频道要支持贴图/贴文件：整页拖拽 + 粘贴直入 + 限额前置整批拒绝的交互组合可直接参照。
- (b) 消息正文中 `路径` 样式的 inline-code 变可点文件链接——对 studio 频道里 agent 汇报"改了哪些文件"的场景价值高，且只需要一个路径解析器，不依赖附件体系。

## 9. 人审/确认 UI

**dsh 做法**：**composer 接管（takeover）模式**——有待决 approval/question 时，整个输入区被对应面板**替换**（流内不再放卡片，避免与输入区双重渲染同一等待）：
- ApprovalPanel：琥珀色 "Waiting for approval" 顶条 + 模型理由 headline + 配对命令的 muted code 文本 + 右对齐 拒绝/允许一次 按钮。**一次性锁存**：点击后按钮禁用，等 resolved 广播帧到达面板才撤（输入框回归）；回答失败重新武装可重试。理由/命令是无界模型文本，卡内滚动（`data-approval-scroll`），**按钮行在滚动区外恒可达**，滚动区本身有 tabIndex 保证纯键盘用户能读到命令尾部。
- QuestionComposer：多问步进流（上一题/下一题、选项 + 自定义文本 + 跳过）；识别出 plan review 意图时走专用的 PlanReviewPanel 形态。
- 依据：`ui-conversation/src/client/skeleton/ApprovalPanel.tsx`（头注释 L1-13、L60-64 锁存、L72 滚动区）、`ui-user-questions/src/client/QuestionComposer.tsx`、`PlanReviewPanel.tsx`、`ChatView.tsx` L398-400（流内不放占位卡片的设计说明）

**studio 现状**：人审走**消息流内卡片**（ChannelMessageItem.tsx `renderCard`：requirements_doc / knowledge_confirm / knowledge_proposal / memory_proposal / distill_proposal / gc_proposal / constraint_audit_proposal / auditor_suggestion 共 8 种），按钮在卡片上；NEED_INPUT 挂起用"等待回复"徽章 + 卡片内嵌回复框（L146-163）。

**借鉴点**：
- (a) **不用照搬 takeover**：studio 频道是多人多 agent 的异步消息流，人审对象天然是"流内一条消息"，卡片内按钮是正确形态；dsh 是单人会话同步 console，takeover 才合理。两种形态各自的合理性值得在决策记录里写明。
- (b) 可借的细节：**一次性锁存 + 失败重武装**（studio 卡片按钮点完到状态回流之间是否有防重复点击，值得逐个卡片核查）；**按钮永远在滚动区外可达**（长内容卡片）；二次确认（RiskConfirmation 的 acknowledge → confirm 两步）用于高危操作（studio 的 retract_confirm / constraint_audit 退役类可考虑）。

## 10. 其他值得知道的细节

- **Turn 级状态行**："Deep diving..." 覆盖首 token 等待/工具执行/流式全程，不因阶段切换闪烁；运行超 15s 才追加计时（`formatRunDuration`）。依据：`ChatView.tsx` L98-140、L403。studio 若要在频道展示"agent 执行中"，这个"全程一行、不逐步闪烁"的原则直接适用。
- **Turn 尾部指标行**（`StatsLine.tsx`/`TurnTailNodeView.tsx`）：回合结束后挂 Ran-for/token 等指标的 footer。
- **模型重试行**（`MessageItem.tsx` ModelRetryItem L50-114）：重试倒计时走本地时钟锚定（不信任 host 时间与 Date.now() 同源），details 展开看失败原因。
- **消息分支（branch/fork）**：`forkAt` 从任意 assistant 回答处分叉会话。与 studio 频道模型不匹配，仅记录。

## 11. 不建议照搬的部分

- dsh 的 cordis 槽位/服务装配体系、`input/machine.ts` 草稿机（chip 事务、U+FFFC 占位符、自有 undo log）、自研增量 Markdown parser——都是为其"单会话 agent console + 插件生态"服务的重量级工程。studio 频道借**交互模式与小组件算法**（台账滚动、帧节流、combobox 键盘、锁存按钮），不借架构。
- WS 下行 + 投影订阅：studio 频道消息粒度下 SSE 已够，不构成升级理由。

## 12. 落地优先级建议（供地图 #245 决策）

| 优先级 | 借鉴点 | 对应 § |
|---|---|---|
| P0 | agent 消息 Markdown/代码块渲染（含复制按钮） | §2 |
| P0 | Esc 关闭 mention 弹框 + IME 合成守卫 | §7 (a)(c) |
| P1 | observed-top 台账滚动归属判定 + ResizeObserver 跟随 + 回到底部按钮 | §5 (a)(b)(c) |
| P1 | 人/agent 分侧布局 + 消息内 @mention chip | §1 (a)(b) |
| P2 | 人审卡片按钮一次性锁存核查 + 高危操作二次确认 | §9 (b) |
| P2 | 加载更早的行锚点补偿 | §6 (a) |
| P3 | 频道恢复阅读位置、滚动阈值收紧 | §5 (d)(e) |
| P3 | thinking 折叠行 / turn 级状态行（依赖 agent 过程数据进频道，属未来能力） | §3、§10 |
