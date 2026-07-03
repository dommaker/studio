---
id: "cmq9h1iok012911l1j3nyndmm"
workUnitId: "cmq9h1j12012k11l194p2vbra"
slug: "create-knowledge-test"
title: "创建 knowledge 冒烟测试文件"
status: "implemented"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["smoke-test", "knowledge"]
createdAt: "2026-06-11T12:26:10.770Z"
updatedAt: "2026-06-11T12:26:11.264Z"
---

# 创建 knowledge 冒烟测试文件

在 apps/api/src/modules/knowledge/__tests__/ 下创建 smoke-test.ts，包含一个 describe+test 断言 1+1=2

<!-- TASK_TIER {"tier":"fast","reason":"单文件创建，无跨模块依赖，无代码行为改动"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":[],"unverified":[],"newRequired":[]} -->

## AC Groups

### smoke-test-creation
<!-- MODEL_TIER {"tier":"fast","reason":"单文件创建，无依赖，无行为改动"} -->

#### 验收标准
- [ ] 在 apps/api/src/modules/knowledge/__tests__/smoke-test.ts 创建文件；添加 describe('smoke', () => { test('1+1=2', () => { expect(1+1).toBe(2); }) });使用 vitest 的 describe/test/expect 导入；不修改任何现有文件

#### 涉及文件
- apps/api/src/modules/knowledge/__tests__/smoke-test.ts
## AC Groups

```json
[
  {
    "id": "smoke-test-creation",
    "targetRepo": "studio",
    "acs": [
      "在 apps/api/src/modules/knowledge/__tests__/smoke-test.ts 创建文件；添加 describe('smoke', () => { test('1+1=2', () => { expect(1+1).toBe(2); }) });使用 vitest 的 describe/test/expect 导入；不修改任何现有文件"
    ],
    "files": [
      "apps/api/src/modules/knowledge/__tests__/smoke-test.ts"
    ],
    "dependencies": [],
    "implementationNotes": "创建文件，内容为 vitest 的 describe+test 断言 1+1=2。参考现有测试文件导入风格：import { describe, it, expect } from 'vitest'",
    "architectureContext": {
      "functions": [],
      "callChain": "无 — 纯测试文件，无被调用方",
      "imports": [
        "import { describe, it, expect } from 'vitest'"
      ],
      "typesInScope": [],
      "testMock": [],
      "dangerZones": [],
      "verifiedAt": "HEAD"
    },
    "codePatterns": [
      "apps/api/src/modules/knowledge/__tests__/knowledge-bus.test.ts:L4 — vitest import 风格"
    ],
    "gotchas": [],
    "modelTier": "fast",
    "modelTierReason": "单文件创建，无依赖，无行为改动"
  }
]
```
## Files

- apps/api/src/modules/knowledge/__tests__/smoke-test.ts