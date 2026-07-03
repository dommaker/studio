---
id: "cmq9k9mox00blox1voj0ngfv6"
workUnitId: "cmq9k9ogg00bwox1vhyroqarh"
slug: "create-knowledge-test-v2"
title: "创建 knowledge 冒烟测试 v2"
status: "implemented"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["smoke-test", "vitest", "knowledge-module"]
createdAt: "2026-06-11T13:56:28.057Z"
updatedAt: "2026-06-11T13:56:30.398Z"
---

# 创建 knowledge 冒烟测试 v2

在 apps/api/src/modules/knowledge/__tests__/ 下创建 smoke-test-v2.ts，验证 vitest 运行环境可用

<!-- TASK_TIER {"tier":"fast","reason":"单文件创建，无改动，无跨模块依赖，无 schema 变更"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":[],"unverified":[],"newRequired":[]} -->

## AC Groups

### smoke-test-v2-file-creation
<!-- MODEL_TIER {"tier":"fast","reason":"单文件创建，无改动，无依赖，内容完全由用户指定"} -->

#### 验收标准
- [ ] 在 apps/api/src/modules/knowledge/__tests__/smoke-test-v2.ts；创建文件，内容为 describe('smoke', () => { it('works', () => { expect(1+1).toBe(2); }); })；导入 import { describe, it, expect } from 'vitest'；不做任何其他修改

#### 涉及文件
- apps/api/src/modules/knowledge/__tests__/smoke-test-v2.ts
## AC Groups

```json
[
  {
    "id": "smoke-test-v2-file-creation",
    "targetRepo": "studio",
    "acs": [
      "在 apps/api/src/modules/knowledge/__tests__/smoke-test-v2.ts；创建文件，内容为 describe('smoke', () => { it('works', () => { expect(1+1).toBe(2); }); })；导入 import { describe, it, expect } from 'vitest'；不做任何其他修改"
    ],
    "files": [
      "apps/api/src/modules/knowledge/__tests__/smoke-test-v2.ts"
    ],
    "dependencies": [],
    "implementationNotes": "直接创建文件。参考现有测试导入风格：import { describe, it, expect } from 'vitest'。文件内容完全按用户指定。",
    "architectureContext": {
      "functions": [],
      "callChain": "无——独立测试文件，不被任何模块调用",
      "imports": [
        "import { describe, it, expect } from 'vitest'"
      ],
      "typesInScope": [],
      "testMock": [],
      "dangerZones": [],
      "verifiedAt": "2026-06-11T20:01:46Z"
    },
    "codePatterns": [
      "参考: apps/api/src/modules/knowledge/__tests__/knowledge-sync-detect.test.ts L8 导入风格"
    ],
    "gotchas": [],
    "modelTier": "fast",
    "modelTierReason": "单文件创建，无改动，无依赖，内容完全由用户指定"
  }
]
```
## Files

- apps/api/src/modules/knowledge/__tests__/smoke-test-v2.ts