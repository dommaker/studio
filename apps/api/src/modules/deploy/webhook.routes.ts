// Deploy Webhook — GitHub push 事件触发的部署入口（触发式部署，替代每分钟轮询的主通道）
//
// 安全：HMAC-SHA256 校验 X-Hub-Signature-256（secret = env DEPLOY_WEBHOOK_SECRET），
// 原始 body 由 app.ts 的 express.raw 挂载保留（同 discord/interactions 先例）。
// 行为：仅接受 push 到 refs/heads/master；202 立即返回后异步触发 auto-deploy.sh
// （脚本内含方向检查/flock/build/restart/health/rollback，幂等可重入）。
import { Router } from 'express';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { logger } from '@dommaker/studio-shared';

export const deployWebhookRoutes = Router();

const DEPLOY_SCRIPT = process.env.DEPLOY_SCRIPT || '/root/projects/studio-config/scripts/auto-deploy.sh';

deployWebhookRoutes.post('/webhook', (req, res) => {
  const secret = process.env.DEPLOY_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'DEPLOY_WEBHOOK_SECRET not configured' });
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

  let ref = '';
  try {
    ref = JSON.parse(body.toString('utf-8'))?.ref ?? '';
  } catch {
    return res.status(400).json({ error: 'invalid payload' });
  }
  if (ref !== 'refs/heads/master') {
    return res.status(202).json({ ignored: ref });
  }

  // 先响应再触发：部署会重启本进程，不能让请求悬着
  res.status(202).json({ accepted: true });
  const child = spawn('bash', [DEPLOY_SCRIPT], { detached: true, stdio: 'ignore' });
  child.unref();
  logger.info('[DeployWebhook] push to master accepted, deploy triggered', { script: DEPLOY_SCRIPT });
});
