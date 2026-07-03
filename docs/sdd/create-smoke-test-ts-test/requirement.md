---
id: "cmq8820xi003t4j3acq1568cb"
workUnitId: "cmq88219300434j3ak2nsmlml"
slug: "create-smoke-test-ts-test"
title: "创建 smoke-test.ts 测试文件"
status: "implemented"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["smoke-test", "file-creation"]
createdAt: "2026-06-10T15:26:51.700Z"
updatedAt: "2026-06-10T15:26:52.145Z"
---

# 创建 smoke-test.ts 测试文件

在 apps/api 根目录创建一个简单的 smoke-test.ts 文件，导出 smoke 常量

<!-- TASK_TIER {"tier":"fast","reason":"单文件创建，无跨模块依赖，无现有代码修改"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":[],"unverified":[],"newRequired":[]} -->

## AC Groups

### create-smoke-test
<!-- MODEL_TIER {"tier":"fast","reason":"单行文件创建，零复杂度"} -->

#### 验收标准
- [ ] 在 apps/api/smoke-test.ts 创建文件，内容为 `export const smoke = true`；文件必须是有效的 TypeScript 模块；不修改任何现有文件

#### 涉及文件
- apps/api/smoke-test.ts
## AC Groups

```json
[
  {
    "id": "create-smoke-test",
    "acs": [
      "在 apps/api/smoke-test.ts 创建文件，内容为 `export const smoke = true`；文件必须是有效的 TypeScript 模块；不修改任何现有文件"
    ],
    "files": [
      "apps/api/smoke-test.ts"
    ],
    "dependencies": [],
    "implementationNotes": "直接用 Write 工具创建文件，内容只有一行 `export const smoke = true`。无导入依赖，无函数逻辑。",
    "architectureContext": {
      "functions": [],
      "callChain": "无调用链，纯导出常量",
      "imports": [],
      "typesInScope": [],
      "testMock": [],
      "dangerZones": [],
      "verifiedAt": "2026-06-10T22:00:00Z"
    },
    "codePatterns": [],
    "gotchas": [],
    "modelTier": "fast",
    "modelTierReason": "单行文件创建，零复杂度"
  }
]
```
## Files

- apps/api/smoke-test.ts