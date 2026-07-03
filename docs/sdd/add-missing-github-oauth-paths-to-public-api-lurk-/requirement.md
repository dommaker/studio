---
id: "cmq6g540301mbqnnhecnn7hk8"
workUnitId: "cmq6g574101moqnnhf1sted7q"
slug: "add-missing-github-oauth-paths-to-public-api-lurk-"
title: "Add missing GitHub OAuth paths to PUBLIC_API Lurk Wall whitelist"
status: "implemented"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["bug", "oauth", "production-gate", "lurk-wall"]
createdAt: "2026-06-09T09:37:40.224Z"
updatedAt: "2026-06-09T09:37:44.295Z"
---

# Add missing GitHub OAuth paths to PUBLIC_API Lurk Wall whitelist

PUBLIC_API in app.ts is missing /auth/github and /auth/callback/github — GitHub OAuth flow is blocked in production by Lurk Wall. /auth/register was reported missing but is already present (false positive).

<!-- TASK_TIER {"tier":"fast","reason":"Single file change (app.ts), 2 string additions to an existing Set, no schema/multi-module impact"} -->
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["GET /auth/:provider(google|github) — oauth.routes.ts:18, mounted at /api/v1/auth (route-registry.ts:165)","GET /auth/callback/:provider(google|github) — oauth.routes.ts:43, mounted at /api/v1/auth (route-registry.ts:165)","Lurk Wall middleware — app.ts:98-105, checks PUBLIC_API Set with prefix matching","/auth/register — already in PUBLIC_API at app.ts:80 (false positive in auto-discovery)"],"unverified":[],"newRequired":[]} -->

### Verified
- ✅ GET /auth/:provider(google|github) — oauth.routes.ts:18, mounted at /api/v1/auth (route-registry.ts:165)
- ✅ GET /auth/callback/:provider(google|github) — oauth.routes.ts:43, mounted at /api/v1/auth (route-registry.ts:165)
- ✅ Lurk Wall middleware — app.ts:98-105, checks PUBLIC_API Set with prefix matching
- ✅ /auth/register — already in PUBLIC_API at app.ts:80 (false positive in auto-discovery)

## AC Groups

### public-api-github-oauth
<!-- MODEL_TIER {"tier":"fast","reason":"2行字符串添加到现有Set，无跨模块依赖，无schema变更"} -->

#### 验收标准
- [ ] 在 app.ts L78-L96 PUBLIC_API Set 中添加 '/auth/github' 和 '/auth/callback/github' 两个条目；确保 GitHub OAuth 登录和回调路径在生产环境不被 Lurk Wall 拦截；不修改 Lurk Wall 中间件的匹配逻辑（startsWith prefix matching），不删除或重排现有条目

#### 涉及文件
- apps/api/src/app.ts
## 约束
- 不修改 Lurk Wall 中间件匹配逻辑
- 不删除或重排现有 PUBLIC_API 条目
- 不改动 oauth.routes.ts 路由定义

## AC Groups

```json
[
  {
    "id": "public-api-github-oauth",
    "acs": [
      "在 app.ts L78-L96 PUBLIC_API Set 中添加 '/auth/github' 和 '/auth/callback/github' 两个条目；确保 GitHub OAuth 登录和回调路径在生产环境不被 Lurk Wall 拦截；不修改 Lurk Wall 中间件的匹配逻辑（startsWith prefix matching），不删除或重排现有条目"
    ],
    "files": [
      "apps/api/src/app.ts"
    ],
    "dependencies": [],
    "implementationNotes": "在 PUBLIC_API Set (L78-L96) 中 /auth/google 和 /auth/callback/google 附近添加对应的 GitHub 条目。保持条目按 provider 分组排列的视觉一致性。",
    "architectureContext": {
      "functions": [
        "registerRoutes(): Promise<void> @ app.ts:72"
      ],
      "callChain": "app startup → registerRoutes() → defines PUBLIC_API → Lurk Wall middleware at /api/v1 prefix",
      "imports": [],
      "typesInScope": [],
      "testMock": [],
      "dangerZones": [
        "L78-L96 PUBLIC_API Set — 只添加条目，不修改现有条目或匹配逻辑",
        "L101 startsWith prefix matching — /auth/google 不匹配 /auth/github，必须显式添加"
      ],
      "verifiedAt": "e7119fc"
    },
    "codePatterns": [
      "app.ts:78-96 — existing PUBLIC_API Set entries"
    ],
    "gotchas": [
      "⚠️ /auth/register 已在 PUBLIC_API (L80) — auto-discovery 报告为 false positive",
      "⚠️ L101 使用 startsWith 做前缀匹配 — /auth/google 不会匹配 /auth/github，必须显式添加"
    ],
    "modelTier": "fast",
    "modelTierReason": "2行字符串添加到现有Set，无跨模块依赖，无schema变更"
  }
]
```

## Files

- apps/api/src/app.ts