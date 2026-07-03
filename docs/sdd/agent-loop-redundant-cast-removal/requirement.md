<!-- GATE_REVISION_ATTEMPT 2 -->

```json
{
  "requirement": {
    "title": "agent-loop.ts 冗余类型断言消除",
    "summary": "agent-loop.ts 中无 as any 断言（0 处）。Scout 发现 1 处冗余 as WorkUnit 断言（L114），prisma.workUnit.findMany() 已返回 WorkUnit[]，该 cast 可安全删除。L61 as RuntimeInstanceRow（Prisma 内部类型差异）和 L68 context as WorkUnit（TriggerExecuteHandler 签名 (context: unknown) 的合法窄化）为必要断言，不可删除。",
    "tier": "fast",
    "tierReason": "单文件单行删除，无架构变更，无新增依赖",
    "acGroups": [
      {
        "id": "ac-remove-redundant-cast",
        "acs": [
          "AC-1: 删除 L114 workUnits[0] as WorkUnit 冗余类型断言，prisma.workUnit.findMany() 已返回 WorkUnit[] 类型数组，无需额外 cast",
          "AC-2: 运行 pnpm test -- agent-loop 确认所有已有测试通过",
          "AC-3: 运行 npx tsc --noEmit 确认类型检查无错误"
        ],
        "files": [
          "apps/api/src/modules/agents/agent-loop.ts"
        ],
        "dependencies": []
      }
    ],
    "constraints": [
      "L61 as RuntimeInstanceRow 保留不删：Prisma create() 返回类型含 __typename/relation 等内部字段，与 RuntimeInstanceRow 接口字段子集不兼容，cast 必要",
      "L68 context as WorkUnit 保留不删：registerExecuteHandler 回调签名为 (context: unknown)，handler 内必须将 unknown 窄化为具体类型，此为正确的事件分发模式",
      "外科手术式修改：仅删除 L114 冗余断言，不修改周边代码、注释或格式",
      "覆盖率不下降：运行 pnpm test -- --coverage 验证"
    ],
    "tags": [
      "agents",
      "type-safety",
      "agent-loop",
      "refactor"
    ]
  },
  "design": {
    "acGroups": [
      {
        "id": "ac-remove-redundant-cast",
        "implementationNotes": "L114 修改前 `await this.tryClaim(workUnits[0] as WorkUnit);` → 修改后 `await this.tryClaim(workUnits[0]);`。tryClaim 入参类型为 WorkUnit，prisma.workUnit.findMany() 返回 WorkUnit[]，数组元素类型已匹配。findMany 配置 take: 1 且 L113 已有 length > 0 守卫，元素必存在。",
        "architectureContext": {
          "functions": [
            "AgentLoop.start(): Promise<void> @ L54 → 调用 scanForWork()",
            "AgentLoop.scanForWork(): Promise<void> @ L100 → findMany 查询 + tryClaim 调用",
            "AgentLoop.tryClaim(workUnit: WorkUnit): Promise<void> @ L141 → 接收 WorkUnit 类型",
            "prisma.workUnit.findMany(...) → WorkUnit[] ← Prisma 生成类型",
            "registerExecuteHandler(name: string, handler: (context: unknown) => Promise<void>): void @ trigger-action"
          ],
          "callChain": "AgentLoop.start() → scanForWork() → prisma.workUnit.findMany() → workUnits[0] → tryClaim(workUnit) [L100→L114→L141]",
          "imports": [
            "import { eventBus, logger } from '@dommaker/studio-shared'",
            "import { prisma } from '@dommaker/studio-prisma'",
            "import { agentExecutor } from '@dommaker/studio-agent'",
            "import { registerExecuteHandler, unregisterExecuteHandler } from '../triggers/trigger-action.js'",
            "import { TriggerScheduler } from '../triggers/trigger-scheduler.js'",
            "import { WorkUnitService } from '../workunit/workunit.service.js'",
            "import type { TriggerConfig } from '../triggers/trigger.types.js'",
            "import type { WorkUnit, AgentProfile } from '@prisma/client'"
          ],
          "typesInScope": [
            "WorkUnit (@prisma/client generated) — tryClaim 入参类型，findMany 直接返回 WorkUnit[]",
            "RuntimeInstanceRow (local interface @ L27-L36)",
            "ExecutionResult (local interface @ L14-L25)",
            "TriggerExecuteHandler = (context: unknown) => Promise<void> — L68 cast 的根因类型",
            "AgentProfile (@prisma/client generated)"
          ],
          "testMock": [
            "测试文件 agent-loop.test.ts: (agentLoop as any).scanForWork() / (agentLoop as any).tryClaim() 等 16 处，属于测试访问私有方法模式问题，不在本次修改范围",
            "测试文件 agent-loop-e2e.test.ts: (TriggerScheduler as any)(null) 等 7 处，不在本次修改范围"
          ],
          "dangerZones": [
            "L61: as RuntimeInstanceRow — Prisma create 返回类型字段集 vs 手写 interface 字段子集不兼容，不可删除",
            "L68: context as WorkUnit — TriggerExecuteHandler 签名 (context: unknown)，回调内必须窄化，不可删除",
            "agent-loop.test.ts: 16 处 (agentLoop as any).xxx 测试访问私有方法，不在本次范围"
          ],
          "verifiedAt": "scout-code + scout-test 双重确认"
        },
        "codePatterns": [
          "Prisma findMany 返回类型已隐式匹配参数类型 → 删除冗余 as WorkUnit 即可",
          "L113 length > 0 守卫保证 workUnits[0] 非空，类型安全"
        ],
        "gotchas": [
          "不可删除 L61 as RuntimeInstanceRow: Prisma create 返回类型含 Prisma 内部字段，interface 字段子集不兼容",
          "不可删除 L68 context as WorkUnit: registerExecuteHandler 签名 (context: unknown)，若想消除此断言需将 registerExecuteHandler 泛型化，但影响所有注册方，非本次范围",
          "agent-loop.ts 本身无 as any 断言，原需求描述与实际情况不符",
          "测试文件 agent-loop.test.ts 有 19 处 as any（访问私有方法），但不在 agent-loop.ts 内"
        ],
        "modelTier": "fast"
      }
    ]
  },
  "task": {
    "acGroups": [
      {
        "id": "ac-remove-redundant-cast",
        "contractTests": [
          {
            "ac": "AC-1: 删除 L114 workUnits[0] as WorkUnit 冗余类型断言",
            "file": "apps/api/src/modules/agents/agent-loop.ts",
            "content": "// 修改验证：删除 workUnits[0] as WorkUnit 中的 as WorkUnit\n// grep 确认 agent-loop.ts 中 workUnits[0] 后不再有 as WorkUnit\n// 预期：grep 'workUnits\[0\] as WorkUnit' agent-loop.ts 返回空"
          },
          {
            "ac": "AC-2: 运行 pnpm test -- agent-loop 确认所有已有测试通过",
            "file": "apps/api/src/modules/agents/__tests__/agent-loop.test.ts",
            "content": "// 验证命令：pnpm test -- agent-loop\n// 预期：所有已有测试通过，退出码 0\n// 覆盖的测试文件：agent-loop.test.ts, agent-loop-e2e.test.ts\n// 验证点：tryClaim(workUnits[0]) 调用签名不变，行为不变"
          },
          {
            "ac": "AC-3: 运行 npx tsc --noEmit 确认类型检查无错误",
            "file": "apps/api/src/modules/agents/agent-loop.ts",
            "content": "// 验证命令：npx tsc --noEmit\n// 预期：类型检查无错误，退出码 0\n// 验证点：删除 as WorkUnit 后 workUnits[0] 类型仍为 WorkUnit（from WorkUnit[]），\n//         tryClaim(workUnit: WorkUnit) 入参类型匹配，编译器不报错"
          }
        ],
        "testFiles": [
          "apps/api/src/modules/agents/__tests__/agent-loop.test.ts",
          "apps/api/src/modules/agents/__tests__/agent-loop-e2e.test.ts"
        ],
        "contractTestsSkipReason": null
      }
    ]
  }
}
```
