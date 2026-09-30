/**
 * deploy 域契约测试（协议面例外：express.raw HMAC-SHA256，路由保持原样）。
 * 正本 = apps/api/src/modules/deploy/webhook.routes.ts。
 */

import { describe, it, expect } from 'vitest';
import { deployWebhookAcceptedSchema, deployWebhookIgnoredSchema, deployWebhookErrorSchema } from '../deploy.js';
import * as contractIndex from '../index.js';

describe('deploy webhook 出参三形态', () => {
  it('202 accepted / 202 ignored / error', () => {
    expect(deployWebhookAcceptedSchema.parse({ accepted: true }).accepted).toBe(true);
    expect(() => deployWebhookAcceptedSchema.parse({ accepted: false })).toThrow();
    expect(deployWebhookIgnoredSchema.parse({ ignored: 'refs/heads/feat/x' }).ignored).toContain('feat');
    expect(deployWebhookErrorSchema.parse({ error: 'invalid signature' }).error).toBeTruthy();
  });
});

describe('index.ts 出口', () => {
  it('deploy 域 schema 经 index 导出', () => {
    expect(contractIndex.deployWebhookAcceptedSchema).toBeDefined();
  });
});
