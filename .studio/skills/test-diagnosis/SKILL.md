---
name: test-diagnosis
description: "测试失败时诊断根因：区分环境问题、依赖问题、代码问题三层，提供系统化 fallback 排查。"
agentTypes: [test, bug]
triggers: [测试失败, 诊断根因, test failure, diagnosis, 环境问题, 依赖问题, ECONNREFUSED, vi.mock, 测试超时, fixture 污染]
status: published
---

## 核心原则

先分类后修复。诊断 → 呈现方案 → 等确认。

---

## 硬门禁

<HARD-GATE>
在将测试失败分类为 L1（环境）/ L2（依赖）/ L3（代码）之前，不得尝试修复。
未分类就修复 = 猜测。每个失败在任何代码变更前必须有层级标签。
</HARD-GATE>

---

## 诊断流程

1. **收集信号**：读取测试失败输出（错误消息 + stack trace + 文件路径）
2. **信号分类**：用三层过滤器归类
   - L1 环境层：运行环境/配置问题（不需要改代码）
   - L2 依赖层：mock/外部依赖/模块解析问题（需要改配置或补 mock）
   - L3 代码层：测试逻辑/数据/API 变更问题（需要改测试代码）
3. **判断真伪**：区分真实失败 vs 环境/配置问题。环境问题不应触发代码修改
4. **优先级排序**：L1 → L2 → L3。环境影响面最大且修复成本最低，先修
5. **呈现方案**：根因类别 + 修复方向 + 影响范围。不自动修复

## 无法归类时的 fallback

分类表不能覆盖所有错误。当信号不匹配任何已知类别时：

1. 提取错误消息中的核心动词/名词（如 `Cannot find module`、`timeout`、`undefined`）
2. 判断属于哪一层（环境/依赖/代码）
3. 给出最可能的假设 + 验证方法（"如果是 X，检查 Y"）
4. 不猜测具体修复，只给排查方向

**原则**：不确定的诊断 > 错误的诊断。宁可说"未知类别，建议检查 X"也不要瞎改代码。

## 并行诊断策略

多文件失败时按文件分组并行诊断（来自 memory `feedback_parallel_test_diagnosis.md`）：
- 按失败文件分组，每组独立诊断
- 不在"全量跑→修→全量跑"循环里浪费时间
- 环境层问题先统一修（一次修复影响多个文件）
- 最后一次性验证

## 快速参考：症状→原因映射

Agent 查表直接定位，不需要推理。命中即验证，不命中再走诊断流程。

| 症状 | 最可能层 | 最可能原因 | 验证方法 |
|------|---------|-----------|---------|
| `ECONNREFUSED` | L1 环境 | 服务未启动/端口占用 | `lsof -i :port` |
| `Cannot find module` | L2 依赖 | 路径错误/未安装 | `ls node_modules`、检查 import 路径 |
| `timeout` / `Timeout exceeded` | L1 或 L3 | 环境慢/死循环/异步泄漏 | 单独跑测试看是否复现 |
| `expect(x).toBe(y)` | L3 代码 | 逻辑错误/API 变更 | 读实现代码确认预期值 |
| `vi.mock` 未生效 | L2 依赖 | mock 路径错误/导入顺序 | 检查 mock 路径是否与 import 一致 |
| fixture 冲突 | L3 代码 | 测试间共享状态被修改 | 检查 `beforeEach`/`afterEach` cleanup |
| `process exited` / SIGKILL | L1 环境 | OOM/信号/未捕获异常 | 检查内存限制、`--maxWorkers`、信号 |
| `describe is not defined` | L1 环境 | vitest globals 未配置 | 检查 `vitest.config.ts` globals 设置 |
| `document is not defined` | L1 环境 | jsdom 环境缺失 | 检查 test 文件 environment 配置 |
| `No "..." export is defined` | L2 依赖 | vi.mock() 缺 export | 对比 mock 定义与实际模块 export |
| `require is not defined` | L2 依赖 | ESM 模块中使用 require | 改为 `import` 或 mock 该模块 |

## 常见误诊反模式

诊断时 Agent 容易犯的错误，每条附带正确做法：

| 误诊 | 正确做法 |
|------|---------|
| 看到 `ECONNREFUSED` 就改代码 | 先查端口占用 + 服务状态，这是 L1 环境问题 |
| 看到 `timeout` 就加 timeout 参数 | 先单独跑测试确认是否复现，排查死循环/异步泄漏 |
| 看到 `Cannot find module` 就装包 | 先检查路径是否正确、是否在 `node_modules` 中、是否是 mock 问题 |
| 多个文件失败时逐个修 | 先找共因——可能是同一个环境问题导致所有失败 |
| 把 mock 失败当代码 bug | mock 未生效通常是路径/配置问题，不是被测代码的问题 |
| 不读完整错误信息就开始修 | error message 和 stack trace 里通常有足够信息定位根因 |
| 修了环境层不全量验证 | 环境修复影响面大，必须全量重跑确认 |

## 自检：诊断完成后逐项检查

诊断完成、呈现方案前，逐项过一遍：

- [ ] **分类正确**：是否正确区分了环境/依赖/代码问题？（没把环境问题当代码修）
- [ ] **读了完整错误信息**：不只看第一行？stack trace 里有没有被忽略的关键信息？
- [ ] **多文件共因**：多个文件失败时，是否先检查了共因？（同一环境问题可能表现为多个不同错误）
- [ ] **针对根因**：修复方案是否针对根因？（不是绕过——加 timeout 是绕过，修异步泄漏是根因）

任一项未通过 → 回到对应步骤重新诊断。

## 根因分类表（辅助参考）

来源：`scripts/test-health-report.ts`（7 类）+ B33 手动修复（7 大类 21 项）+ 知识库条目

### L1 环境层

| ID | 根因 | 信号 |
|---|---|---|
| E1 | vitest globals 未配置 | `describe is not defined` / `it is not defined` / `expect is not defined` |
| E2 | jsdom 环境缺失 | `document is not defined` / `window is not defined` |
| E3 | runner 混淆（Playwright 被 vitest 加载）| 文件路径含 `/e2e/` + `.spec.ts` |
| E4 | 端口/环境变量不匹配 | `ECONNREFUSED` + 集成测试文件 |
| E5 | globalSetup 缺失 | 连接失败 + setup 相关错误 |

### L2 依赖层

| ID | 根因 | 信号 |
|---|---|---|
| M1 | vi.mock() 缺 export | `No "..." export is defined on the` |
| M2 | mock 路径深度错误 | import 路径 vs mock 路径不一致 |
| M3 | 外部依赖未 mock | 意外网络调用/DB 访问错误 |
| R1 | workspace import 不可解析 | `Cannot find module '@prisma/client'` |
| R2 | ESM 顶层 require() 失败 | `require is not defined` |

### L3 代码层

| ID | 根因 | 信号 |
|---|---|---|
| D1 | 硬编码路径过期 | 路径不匹配 + `ENOENT` |
| D2 | stale test data/fixture | 断言值与当前数据不一致 |
| D3 | 字符串操作错误 | 位置计算偏差 |
| F1 | DOM cleanup 缺失 | 后续测试出现前一个测试的 DOM 元素 |
| F2 | 选择器不唯一 | `getByText` 匹配多个 |
| F3 | import 入口错误 | matcher 不存在 |
| S1 | 硬编码凭证 | 401/403 + 凭证相关 |
| C1 | 已归档功能的测试未清理 | 测试 import 不存在的模块/函数 |
| C2 | API 变更测试未跟 | 参数数量/类型不匹配 |
| T1 | 测试超时 | `Timeout exceeded` |
| T2 | 测试间状态泄漏 | 测试顺序敏感失败 |

## 与已有工具/规则的关系

| 工具/规则 | 职责 | 与 Skill 关系 |
|-----------|------|-------------|
| `test-health-report.ts` | 自动匹配常见环境错误（vitest globals / jsdom / playwright / ECONNREFUSED / mock 不完整 / env 不匹配 / session 未找到）| 自动化 L1 部分。Skill 覆盖 L2 + L3 及未自动化场景 |
| `feedback_parallel_test_diagnosis.md` | memory 规则：禁止全量跑→修→全量跑循环 | Skill 内联此策略 |
| `vitest --reporter` | 输出测试失败信息 | Skill 消费其输出 |

**Skill 的独特价值**：test-health-report 只能匹配 7 种已知模式。Skill 覆盖所有 20 种根因类别 + 提供未知错误的 fallback 排查框架。

## 反模式

- ❌ 看到失败就改代码（不分类，可能改错方向）
- ❌ 一个一个试（没有信号匹配，纯试错）
- ❌ 修了环境层不验证（环境修复后应全量重跑确认）
- ❌ 把环境问题当代码问题修（ECONNREFUSED 不是代码 bug）
- ❌ 无法归类时瞎猜修复（应给排查方向，不给具体修复）

> 详细误诊场景见**常见误诊反模式**节。诊断完成后的检查清单见**自检**节。

--- Self-Review: done ---
