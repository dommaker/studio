// Deploy Webhook — GitHub push 事件触发的部署入口（触发式部署，替代每分钟轮询的主通道）
//
// 安全：HMAC-SHA256 校验 X-Hub-Signature-256（secret = env DEPLOY_WEBHOOK_SECRET），
// 原始 body 由 app.ts 的 express.raw 挂载保留（同 discord/interactions 先例）。
// 行为：仅接受 push 到 refs/heads/master；delivery + commit 原子去重后 spawn 部署脚本，
// 台账 complete 成功才回 202（路径 = env DEPLOY_SCRIPT，未配置按 503 处理，同
// DEPLOY_WEBHOOK_SECRET；脚本内含方向检查/flock/build/restart/health/rollback，幂等可重入）。
// 日志：脚本 stdout/stderr 追加到 env DEPLOY_LOG（默认 /var/log/studio-deploy.log）——
// stdio: 'ignore' 曾导致 webhook 通道部署零日志（2026-08-09 修复）。
import { Router } from 'express';
import crypto from 'crypto';
import fs from 'node:fs';
import { spawn } from 'child_process';
import { logger } from '@dommaker/studio-shared/node';
import { getStore } from '../../core/store.js';
import { ReplayGuard, REPLAY_TTL_MS } from '../../core/replay-guard.js';

export const deployWebhookRoutes = Router();

deployWebhookRoutes.post('/webhook', async (req, res) => {
  const secret = process.env.DEPLOY_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'DEPLOY_WEBHOOK_SECRET not configured' });
  }

  const deployScript = process.env.DEPLOY_SCRIPT;
  if (!deployScript) {
    return res.status(503).json({ error: 'DEPLOY_SCRIPT not configured' });
  }

  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body)) {
    return res.status(400).json({ error: 'raw body required' });
  }

  // HMAC-SHA256 签名校验（timing-safe）
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  const valid = !!signature
    && signature.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) {
    logger.warn('[DeployWebhook] invalid signature rejected');
    return res.status(401).json({ error: 'invalid signature' });
  }

  if (req.headers['x-github-event'] !== 'push') {
    return res.status(202).json({ ignored: 'not a push event' });
  }

  let payload: { ref?: unknown; after?: unknown };
  try {
    payload = JSON.parse(body.toString('utf-8'));
  } catch {
    return res.status(400).json({ error: 'invalid payload' });
  }
  const ref = typeof payload?.ref === 'string' ? payload.ref : '';
  if (ref !== 'refs/heads/master') {
    return res.status(202).json({ ignored: ref });
  }

  const delivery = req.headers['x-github-delivery'];
  if (typeof delivery !== 'string' || !delivery.trim()) {
    return res.status(400).json({ error: 'delivery id required' });
  }
  const commit = typeof payload.after === 'string' ? payload.after.toLowerCase() : '';
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) || /^0+$/.test(commit)) {
    return res.status(400).json({ error: 'valid commit id required' });
  }
  const guard = new ReplayGuard(getStore());
  let claim;
  try {
    claim = await guard.claim([
      { key: `deploy-delivery:${delivery}`, ttlMs: REPLAY_TTL_MS },
      { key: `deploy-commit:${commit}`, ttlMs: null },
    ]);
  } catch (error) {
    logger.error('[DeployWebhook] replay guard unavailable', { error: String(error) });
    return res.status(503).json({ error: 'replay guard unavailable' });
  }
  if (claim.status === 'replayed') {
    return res.status(202).json({ ignored: 'duplicate request' });
  }

  // 日志落盘：stdio ignore 会把脚本输出全部丢弃，部署排错只剩 state.json（2026-08-09 事故）
  const logPath = process.env.DEPLOY_LOG || '/var/log/studio-deploy.log';
  let stdio: 'ignore' | ['ignore', number, number] = 'ignore';
  let logFd: number | undefined;
  try {
    logFd = fs.openSync(logPath, 'a');
    stdio = ['ignore', logFd, logFd];
  } catch (err) {
    logger.warn('[DeployWebhook] DEPLOY_LOG 不可写，部署输出将丢弃', { logPath, error: String(err) });
  }
  try {
    try {
      const child = spawn('bash', [deployScript], { detached: true, stdio });
      child.unref();
    } catch (error) {
      // 同步 spawn 失败证明未启动部署，允许释放后重试。
      await guard.release(claim.token).catch(() => {});
      logger.error('[DeployWebhook] failed to spawn deployment; delivery may be retried', { error: String(error) });
      return res.status(503).json({ error: 'failed to trigger deployment' });
    }
    try {
      await guard.complete(claim.token);
    } catch (error) {
      // 已 spawn，complete 失败必须保留 processing，禁止同 ID 再部署。
      logger.error('[DeployWebhook] deployment started but replay completion failed', { error: String(error) });
      return res.status(503).json({ error: 'deployment started; replay completion failed' });
    }
    logger.info('[DeployWebhook] push to master accepted, deploy triggered', { script: deployScript });
    return res.status(202).json({ accepted: true });
  } finally {
    if (logFd !== undefined) fs.closeSync(logFd); // fd 已在 spawn 时复制给子进程
  }
});
