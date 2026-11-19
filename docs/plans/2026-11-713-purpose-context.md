# #713 按实现、评审、恢复和委派组装上下文

## 目标

- 在现有 `composeStepPrompt` 公共接缝按用途组装 implementation / review / recovery / delegation 上下文。
- 实现与恢复保留目标、Mandate、AC、仓库规则和相关知识；恢复继续使用 #711 持久状态恢复包。
- 评审显式包含需求、AC、从真实 worktree 读取的 base/head diff 和验证证据，禁止父回复、旧 session 摘要/进展与实现者提示进入评审 prompt。
- 委派只保留子范围、必要文件引用与产出契约，不注入角色自述、通用 Skills、父 PMO 地图、角色记忆或通用知识。
- 四种用途继续受现有九段软定额与池内余量共享约束；新增用途正文复用 handoff 段预算，不扩大总预算。

## 已确认测试接缝

沿用父规格 Testing Decisions 指定的 `composeStepPrompt` prompt composition 公共接缝。测试只断言最终 `prompt` / `knowledgeContext`、知识消费与截断事件，不测试私有 purpose 判定 helper。评审实际 diff 用临时真实 Git 仓库验证。

评审建单与 DELEGATE 建单沿用父规格 WorkUnit 应用操作接缝，分别验证父会话待答内容隔离、必要 fileRefs 传递；`clearSessionBookkeeping` 既有纯函数契约测试同步覆盖字段清单。

## 实施步骤

1. 在 `prompt-composer.test.ts` 先补实现/评审 RED：实现包含 Mandate 与 AC；评审包含需求、AC、diff 与验证证据，并排除父进展、sessionSummary 和实现者 hint。
2. 在 `prompt-section-handoff.ts` 渲染有预算的用途正文，在 `prompt-composer.ts` 判定用途并裁剪 review 的通用段与 hint。
3. 补恢复/委派 RED：恢复保留结构化恢复包与适用契约；委派只含子范围、必要引用和期望产出，不调用通用知识注入。
4. 实现 delegation 段裁剪与旧 handoff 阻断；保留 review/delegation 自身的 typed StepRecord 恢复能力。
5. 更新 agent-loop CONTEXT，运行相关单文件测试、受影响测试与 typecheck，随后 code-review 并提交当前 master。

## 非目标

- 不实现 #714 的 section revision / full-delta cursor。
- 不改公开 REST 契约、Mandate 授权规则、StepRecord 结构或评审/委派建单流程。
- 不整份注入 transcript，不新增 prompt 段定额或扩大注入总预算。
