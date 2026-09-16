# CLI 能力探测 + auth 诊断 + 失败分类器

本文件是设计提案，待评审。方案三件套：能力探测（spawn 前探 flag 支持集）、auth 探测（不猜配置目录）、失败分类（报错映射为修复指引）。

## 背景与现状

`packages/studio-shared/src/providers.ts` 的 BUILTIN_PROVIDERS 把 flag 写死在 spawn 模板里（如 codex `baseArgs` 内嵌 `--dangerously-bypass-hook-trust`，claude 内嵌 `--verbose`）。`buildArgsFromTemplate()` 只做占位替换和条件追加，不校验目标 CLI 版本是否认识这些 flag——用户机器上 CLI 版本不符时，报错在 spawn 之后才以原始 stderr 透传回来。

`apps/api/src/daemon/cli-scanner.ts` 只探两件事：`which` 存在性 + `versionArgs` 版本串。结果经 `local-workspace.ts` 写入 workspace 记录的 `runtimes` 数组，由 `GET /api/v1/workspaces/runtimes` 暴露给前端（`useDetectedProviders.ts`）。登录态完全不探：CLI 装了但没登录，用户要到 agent 跑挂才知道。

执行失败路径：`runner-execution.ts` 的 catch 把 `errMsg + stdout 尾部 500 字符` 原样塞进 `ExecutionResult.error` / `failureLog` 返回；仅有的结构化处理是 RKB `queryResolutionHints`（注入下一轮 prompt，非用户可见指引）。`apps/api/src/modules/triage/error-class.ts` 有 `classifyFailure`（auth_failure/rate_limit 等模式表），但输出是内部路由策略（auto_retry/escalate），不产生「去哪修」的指引，且位于 apps/api，studio-agent 不可导入。

## 目标与非目标

目标：

- spawn 前知道目标 CLI 支持哪些 flag，不支持的 flag 不传，报错前置为可诊断信息。
- CLI 清单带登录态（ok/failed/unknown 三态，unknown 不瞎猜），API 和 UI 可见。
- agent 跑挂时返回「失败类别 + 去哪个配置文件/命令修」的指引，替代原始报错透传。

非目标：不改 provider 注册表整体结构（只做增量字段）；动态模型发现（listModels）不做（留开放问题）；嵌套 agent 的 stream-json 误杀只核查给结论，修复另开票；不做远程节点探测（远程方向已废弃）。

## 方案

### 阶段 1：能力探测层

注册表增量字段（`ProviderDefinition` 加可选字段，结构不动）：

```ts
capabilityProbe?: {
  /** 探测命令参数，如 ['--help']；codex 的 flag 在子命令上，应为 ['exec', '--help'] */
  helpArgs: string[];
};
```

- 新模块 `packages/studio-shared/src/capability-probe.ts`（node-only，与 cli-scanner 同样的 `execFileSync` 同步风格）：跑 `<binary> <helpArgs>`，用 `/--[a-z0-9][a-z0-9-]*/g` 从输出解析 flag 集合，产出 `Map<providerId, Set<string>>`。
- 缓存与刷新：**进程内缓存，key = binary path + version 串**（version 变了说明 CLI 升级，自然重探）。daemon 启动时随 `scanLocalRuntimes` warm 一次（同批探测，best-effort 不阻断启动）；首次 spawn 时缓存未命中则懒探测。不落盘——重探成本是每 provider 一次 `--help`，可忽略。
- 消费点：`cli-adapter.ts` 的 `buildSpawnArgs()` 保持纯函数签名兼容，新增可选参数 `supportedFlags?: Set<string>`；调用方（runner 层）从缓存取 map 传入。过滤规则：模板中标记为「条件 flag」的项（第一批只标 codex 的 `--dangerously-bypass-hook-trust`，见下）在 supportedFlags 里不存在时剔除。**探测失败（help 跑不出来/解析为空）→ fail-open 保持现状传全部 flag + warn 日志**，不因探测故障改变现有行为。
- 条件 flag 声明：模板加 `conditionalFlags?: string[]`（列出 baseArgs 里允许被探测剔除的 flag），不重组 baseArgs 本体——claude 的 baseArgs 有「byte-identical 回归风险」注释，第一版只把 codex 的 hook-trust flag 标为条件项，其余 provider 的 baseArgs 不动（它们是核心协议 flag，缺了 CLI 直接不可用，探测剔除无意义）。
- 触及文件：`packages/studio-shared/src/providers.ts`（字段 + codex 声明）、新增 `capability-probe.ts` + 测试、`packages/studio-agent/src/cli-adapter.ts`（过滤逻辑）、runner 调用点传参、`cli-scanner.ts`（warm 挂钩）。

### 阶段 2：authProbe 声明

注册表增量字段：

```ts
authProbe?: {
  /** 登录态探测命令参数，如 codex ['login', 'status']（具体命令逐 provider 实测确认，见实施核查项） */
  args: string[];
  timeoutMs?: number;
};
```

- 判定：exit code 0 + 输出不命中已知未登录模式 → `ok`；命中已知模式或非零 exit → `failed`；**provider 未声明 authProbe 或探测自身出错 → `unknown`，不根据配置目录/凭证文件存在性猜测**。
- 探测结果挂在 `DetectedRuntime` 上：`auth?: 'ok' | 'failed' | 'unknown'` + `authHint?: string`（failed 时的修复命令提示，如「运行 `codex login`」）。
- 流向：`scanAllProviders()` 扩展 → `local-workspace.ts` 写入 runtimes 条目 → `GET /workspaces/runtimes` 返回 → UI 在 provider 下拉里对 `failed` 标徽标 + hint，`unknown` 不标。
- 节奏：auth 探测有进程开销，不随每次 GET 重跑——随启动扫描 + 手动 rescan 跑，结果随 runtimes 记录持久（附 `authCheckedAt`）。端点现有 `apiCache(60)` 不变。
- 触及文件：`providers.ts`（字段 + 各 provider 声明）、`cli-scanner.ts`（探测实现）、`local-workspace.ts`（透传）、`apps/web/src/hooks/useDetectedProviders.ts` + 下拉组件（徽标）、各自测试。

### 阶段 3：失败分类器

- 落点：**纯函数分类器放 `packages/studio-shared/src/llm/failure-classifier.ts`**（与 stream-json-parser 同层，studio-agent 和 apps/api 都可导入）。不放 cli-adapter（它是纯 args 构造，不见错误）；不放 agent-runner 内部（apps/api 侧的 triage/告警也要消费同一分类）；不改 apps/api triage 现有 `classifyFailure`（内部路由策略，语义不同，见开放问题 3）。
- 接口：

```ts
classifyCliFailure(input: {
  provider: string;
  exitCode?: number;
  output: string;      // stderr + stdout 尾部拼接
}): {
  category: 'auth' | 'quota' | 'rate_limit' | 'cli_not_found' | 'flag_unsupported' | 'unknown';
  guidance: string;    // 去哪修：具体配置文件路径或命令，如「运行 claude login 重新登录」
} | null;              // null = 无已知特征，走原有透传
```

- 模式表 per-provider 声明已知特征（如 claude 的 `Invalid API key`/`Not logged in`、通用的 `429`/`quota exceeded`、`unknown option --xxx`），每条映射到修复指引；指引文本必须是产品语言，不含内部环境信息。
- 衔接：`runner-execution.ts` catch 路径和 `runner-lightweight.ts` 失败路径先过分类器——命中时 `ExecutionResult` 增结构化字段 `failureClass: { category, guidance }`，`error` 字符串前缀 `[category] guidance`，原有 RKB `queryResolutionHints` 逻辑不变（两者并存：分类器给用户看，RKB 给下一轮 agent 看）。agent-loop / UI 消费 `failureClass` 渲染指引卡（UI 渲染另起小改，本票只保证字段透出）。
- 触及文件：新增 `failure-classifier.ts` + 测试、`runner-execution.ts`、`runner-lightweight.ts`、`services/types.ts`（ExecutionResult 字段）。

### 顺带核查项结论（不在主线范围，修复另开票）

stream-json 嵌套 agent 防护：**确认存在缺口**。`stream-json-parser.ts` 的 `StreamEvent` 无 `parent_tool_use_id` 字段（全仓 grep 无匹配），`extractResult()` 对所有 `result` 事件无差别处理——`is_error` 跨事件 OR、`text` 取最后一个 result。子 agent（Task 工具）若产生带 `is_error` 的 result 事件，会把父 run 误判为失败（正解是按 `parent_tool_use_id` 过滤子树事件）。`extractUsage` 同样无父子区分，token 会父子双计。修复方向（另开票）：解析层按 `parent_tool_use_id` 过滤非顶层事件，只统计顶层 result/usage。

## 验收标准（AC）

- AC1：codex 声明 `capabilityProbe.helpArgs = ['exec', '--help']` 与 `conditionalFlags = ['--dangerously-bypass-hook-trust']`；mock help 输出不含该 flag 时 `buildSpawnArgs` 产物剔除之，含则保留（单测）。
- AC2：能力探测进程内缓存按 binary path + version 作 key；同 key 二次探测不重复执行（单测计数断言）；探测失败 fail-open 且 argv 与现状逐字节一致（回归断言）。
- AC3：每个内置 provider 的 auth 三态：`ok`/`failed`/`unknown`；未声明 authProbe 的 provider 恒 `unknown`，无配置目录猜测逻辑（代码走查 + 单测）。
- AC4：`GET /workspaces/runtimes` 返回条目含 `auth` 字段；UI 下拉对 `failed` 显示徽标与修复 hint。
- AC5：构造 auth/quota/未知三类失败输出，`classifyCliFailure` 分别命中 `auth`（指引含登录命令）、`quota`、返回 `null`（单测）。
- AC6：runner 失败路径命中分类时 `ExecutionResult.failureClass` 带出 category+guidance，`error` 文本含指引前缀；未命中时行为与现状一致（runner 层测试）。
- AC7：新增代码均有测试；`pnpm typecheck` 无错；受影响测试全绿。

## 风险与边界

- 各 CLI `--help` 输出形态不一（主命令 vs 子命令），`helpArgs` 必须逐 provider 实测，不靠猜——列为实施核查项。
- auth 探测命令真实性同上当实测；无任何 provider 给出「半可靠」探测，宁可 unknown。
- fail-open 语义意味着探测故障时旧问题（版本不符报错）仍会原样发生——可接受，这是增量改进不是回归源。
- 增量字段经 `~/.studio/providers.json` 深合并天然可被用户扩展 provider 继承，无需额外工作。

## 不做清单

- 不动 BUILTIN_PROVIDERS 现有 baseArgs 内容（除 codex 条件 flag 标注）。
- 不做 listModels 动态模型发现。
- 不修 stream-json 嵌套 agent 误杀（仅给结论，另开票）。
- 不做探测结果跨进程持久化（FileStore 落盘），进程内缓存够用。
- 不统一 triage `classifyFailure` 与新分类器的模式表（见开放问题 3）。

## 开放问题（全部已决策，2026-09-16 人审）

1. **探测失败语义**：fail-open（推荐，保持现状行为）还是 fail-closed（探测失败就不传任何条件 flag）？→ **已决策：fail-open**——探测失败回到现状全量传参，不引入新失败模式。
2. **auth 探测节奏**：推荐「启动 + 手动 rescan，结果随 runtimes 记录持久」；备选是每次 GET 实时探（开销大、有 `apiCache(60)` 也压不住 per-provider 进程 spawn）。是否接受 auth 状态最多陈旧到下次启动/rescan？→ **已决策：启动时探 + 手动 rescan + 结果持久化**，不做每次 GET 实时探。
3. **两套失败模式表**：triage `classifyFailure`（内部路由）与新 `failure-classifier.ts`（用户指引）并存，还是本票就收敛为一表两输出？→ **已决策：两套并存**——triage 管内部路由策略，新分类器管给人看的修复指引，收敛另议。
4. **listModels**：动态模型发现（探测 CLI 支持的模型列表）确认排到后续票？→ **已决策：确认不在本票**，排后续独立票。

## 实施时核查项（不许凭记忆写代码）

- 逐 provider 实测：`codex exec --help`、`claude --help`、`kimi --help`、`opencode run --help` 的真实输出，确认 flag 解析正则与条件 flag 清单。
- 逐 provider 核实 auth 探测命令是否真实存在且可靠（item 提到的 `codex login status` 需验证；claude/kimi/opencode 有无等价命令未知，没有就不声明、报 unknown）。
- 各 CLI 未登录/配额耗尽时的真实 stderr 与 exit code 样本（喂分类器模式表，各 1-2 条实测样本，脱敏后入测试 fixture）。
- 能力探测的解析粒度：`--help` 全文正则抓 flag 是否足够（同名 flag 出现在描述文本中的误报率），以实测输出为准定稿解析正则。

## 实施核查结论（#565，2026-09-16 实测）

- 版本：claude 2.1.273、kimi 0.38.0、codex-cli 0.147.0、opencode 1.18.18。
- **能力探测**：`codex exec --help` 全文含 `--dangerously-bypass-hook-trust`（与 `--json` 等并列），`/--[a-z0-9][a-z0-9-]*/g` 全文抓够用（flag 均以 `--xxx` 形态出现在选项行；同名 flag 出现在描述文本的误报对「存在性判定」无害——误判为支持 = fail-open 现状行为）。
- **auth 探测**：claude `auth status` exit 0 输出 JSON（`loggedIn` 布尔字段）→ 声明，未登录模式 `"loggedIn"\s*:\s*false`；codex `login status` 未登录 exit 1 + 输出 "Not logged in"（干净 CODEX_HOME 实测）→ 声明；kimi `login` 无 status 子命令（实测报 "too many arguments"）→ 不声明；opencode `auth list` 把 env 凭证（OPENAI_API_KEY 等）与登录态混排，无可靠判定 → 不声明。
- **失败分类器样本**：codex "Not logged in"（exit 1）为实测；claude auth JSON 形态实测；配额/限流/unknown option 为各家通用 CLI 错误形态（脱敏入 `failure-classifier.test.ts` fixture）。
- **注意**：本机 `/root/.codex/config.toml` 是失效配置（wire_api=chat 已废弃），codex 任何命令 exit 1 —— auth 探测会报 failed（引导修配置/重登录），语义可接受。
