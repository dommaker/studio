---
id: "sdd-1784366584324-h4pwmr"
goalId: "cmq7g1mwq00bk13h6sg979x6r"
slug: "auth-endpoints-rate-limiting"
title: "Auth Endpoints Rate Limiting"
status: "done"
version: 7
taskVersion: 7
parentId: "sdd-1784366260739-sgfsyz"
changeType: "L3"
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["security", "auth", "rate-limiting", "brute-force-prevention"]
createdAt: "2026-06-10T02:22:37.888Z"
updatedAt: "2026-07-18T09:23:04.324Z"
---

# Auth Endpoints Rate Limiting

为 login/register/refresh 端点添加基于 IP 的速率限制，防止暴力破解攻击

<!-- TASK_TIER {"tier":"standard","reason":"修改 2 文件（rate-limit.ts 扩展 + routes.ts 接入），无 schema 变更，但 refresh 端点公开无认证属高风险安全修复"} -->

## Contract Tests

### __tests__/rate-limit-auth.test.ts
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// Contract tests for auth rate limiting
// These tests verify that rate limiters are correctly wired to auth endpoints

const TEST_CREDS = { email: 'test@example.com', pw: 'wrong-pw' };

describe('Auth Rate Limiting', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    // Import the actual auth router after implementation
    // app.use('/api/v1/auth', authRoutes);
  });

  describe('POST /auth/login rate limit', () => {
    it('should return 429 after 10 requests in 1 minute', async () => {
      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: TEST_CREDS.email, password: TEST_CREDS.pw });
        expect(res.status).not.toBe(429);
      }
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: TEST_CREDS.email, password: TEST_CREDS.pw });
      expect(res.status).toBe(429);
      expect(res.body.error).toMatch(/too many/i);
    });
  });

  describe('POST /auth/register rate limit', () => {
    it('should return 429 after 10 requests in 1 minute', async () => {
      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .post('/api/v1/auth/register')
          .send({ email: `test${i}@example.com`, password: TEST_CREDS.pw });
        expect(res.status).not.toBe(429);
      }
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: 'test10@example.com', password: TEST_CREDS.pw });
      expect(res.status).toBe(429);
    });
  });

  describe('POST /auth/refresh rate limit', () => {
    it('should return 429 after 20 requests in 1 minute', async () => {
      for (let i = 0; i < 20; i++) {
        const res = await request(app)
          .post('/api/v1/auth/refresh')
          .send({ refreshToken: 'invalid-token' });
        expect(res.status).not.toBe(429);
      }
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'invalid-token' });
      expect(res.status).toBe(429);
    });
  });

  describe('unaffected endpoints', () => {
    it('should not rate limit POST /auth/guest-session', async () => {
      // guest-session should not have rate limiting
      for (let i = 0; i < 15; i++) {
        const res = await request(app)
          .post('/api/v1/auth/guest-session')
          .send({});
        expect(res.status).not.toBe(429);
      }
    });
  });
});
```