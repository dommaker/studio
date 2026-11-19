# #706 用 Mandate 固定授权与越权交回

## 目标

- 在既有 WU 事件流中以 typed 内部值持久化 Mandate，记录服务端请求人、来源、REQ/PMO/WU、仓库/腿、交付动作、预算、策略版本和授权历史。
- 建单时签发、派生时显式继承且不扩权；频道回复、Subscription 和文件引用只提供上下文。
- 仅认证 Operator、项目 owner 或策略授权主体可扩仓、扩交付动作和追加预算；提供撤销/重新授权语义。
- claim/Assignment 恢复与 Git merge 前重验，撤销或越界不得启动后续执行/副作用。

## 已确认测试接缝

1. `WorkUnitService`：建单、派生、授权、撤销、恢复，验证持久化与操作人。
2. 频道消息路由/等待恢复：普通回复与文件引用不扩权，越界变化交回授权。
3. `merge-on-review-pass`：延迟/恢复 merge 前重验，撤销或越界时零 Git 子进程。

## 实施步骤

1. 以 WorkUnitService 建单为首个纵切：新增 Mandate 类型和建单 RED，签发包含血缘、范围、预算与策略版本的记录后转 GREEN。
2. 增加派生继承 RED：子 WU 只继承父授权子集，不复制 Assignment/会话；越界派生拒绝。
3. 增加授权/撤销/重新授权 RED：操作人只接受服务端 Principal；实现统一语义命令和授权者判定，项目 owner 经既有 project-read 端口读取。
4. 给频道建单/恢复传认证 Principal；预算、归属等会扩大范围的恢复改走授权命令，普通回复保持只追加上下文。
5. 给 claim/Assignment 恢复和 merge 增加重验 RED；失败时阻止新 Assignment 或 Git 子进程，保留可审计的交回状态。
6. 保持旧 WU 可读；仅能从可靠证据派生 Mandate，否则敏感操作要求 Operator 重新授权，不伪造历史请求人。
7. 更新 workunit/channels/agent-loop/pmo 相关 CONTEXT；运行单文件测试、受影响测试、typecheck 与 `vitest run --changed origin/master`，然后 code-review 并提交当前 master。

## 非目标

- 不新增数据库、通用订阅平台或公开跨模块 Mandate 存储 API。
- 不实现 #707 的通用 Effect 框架；本票只提供后续 Effect 可消费的重验与撤销事实。
- 不用 LLM 判断自然语言是否越权；实际扩仓、扩动作、追加预算和敏感副作用由确定性守卫拦截。
- 不改无关 UI、通知或部署流程。
