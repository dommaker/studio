/**
 * Discord Interactions Endpoint
 *
 * 处理 Discord 按钮点击回调
 * 文档：https://discord.com/developers/docs/interactions/receiving-and-responding
 */

import express, { Router, Request, Response } from 'express';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '../../utils/logger.js';
import { eventStore } from '../../core/event-store.js';

const router = express.Router();
const redis = eventStore;

// Discord Interaction Types
const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

// Discord Response Types
const ResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
} as const;

// Button Component Types
const ComponentType = {
  BUTTON: 2,
} as const;

/**
 * 验证 Discord 签名（Ed25519）
 */
function verifyDiscordSignature(
  body: string,
  signature: string,
  timestamp: string,
  publicKey: string
): boolean {
  try {
    const message = Buffer.from(timestamp + body, 'utf-8');
    const signatureBuffer = Buffer.from(signature, 'hex');
    const publicKeyRaw = Buffer.from(publicKey, 'hex');

    const spkiKey = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      publicKeyRaw,
    ]);

    const keyObject = require('crypto').createPublicKey({
      key: spkiKey,
      format: 'der',
      type: 'spki',
    });

    const result = require('crypto').verify(null, message, keyObject, signatureBuffer);
    return result;
  } catch (error) {
    logger.error({ error: String(error) }, 'Discord signature verification error');
    return false;
  }
}

/**
 * POST /api/v1/discord/interactions
 *
 * 签名验证优先：Discord 会先发无效签名请求来检测服务器是否做验证，
 * 跳过验证直接返回 PONG 会导致 URL 验证失败。
 */
router.post('/interactions', async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers['x-signature-ed25519'] as string;
  const timestamp = req.headers['x-signature-timestamp'] as string;
  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  if (!publicKey) {
    logger.error('[Discord] DISCORD_PUBLIC_KEY not configured');
    res.status(500).json({ error: 'Server configuration error' });
    return;
  }

  // req.body 是 express.raw() 提供的原始 Buffer
  const rawBody = req.body as Buffer;
  const rawBodyStr = rawBody.toString('utf-8');

  // 验证 Ed25519 签名（必须优先于所有业务逻辑）
  if (!signature || !timestamp || !verifyDiscordSignature(rawBodyStr, signature, timestamp, publicKey)) {
    res.status(401).send('invalid request signature');
    return;
  }

  // 解析 JSON body
  let body: any;
  try {
    body = JSON.parse(rawBodyStr);
  } catch {
    res.status(400).send('Invalid JSON');
    return;
  }

  // PING: URL 验证（签名已验证通过）
  if (body.type === InteractionType.PING) {
    res.json({ type: ResponseType.PONG });
    return;
  }

  // Slash Command 处理 (B3-001)
  if (body.type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = body.data || {};
    const subcommand = options?.[0]?.name || name;

    logger.info({ name, subcommand }, '[Discord] Slash command');

    try {
      if (name === 'studio') {
        const daemon = require('../../daemon/studio-daemon.js').daemon;
        const status = daemon.getStatus();

        if (subcommand === 'status') {
          const sessions = (status as any[]).filter(Boolean).map((s: any) =>
            `- ${s.name}: ${s.isBusy ? '🔵 busy' : '🟢 idle'} (tasks: ${s.taskCount})`
          ).join('\n');
          res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `**Studio Status**\n${sessions || 'No active sessions'}` } });
          return;
        }

        if (subcommand === 'restart') {
          daemon.stop();
          daemon.start();
          res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: '✅ Daemon 已重启' } });
          return;
        }

        if (subcommand === 'log') {
          const { execSync } = await import('child_process');
          try {
            const logs = execSync('tail -20 /tmp/studio-daemon.log 2>/dev/null || echo "No log file found"', { encoding: 'utf-8', timeout: 5000 });
            res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `**Recent Logs**\n\`\`\`\n${logs.slice(-1500)}\n\`\`\`` } });
          } catch {
            res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: 'No logs available' } });
          }
          return;
        }

        if (subcommand === 'send') {
          const cmd = options?.[0]?.options?.find((o: any) => o.name === 'command')?.value;
          if (!cmd) {
            res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: 'Usage: /studio send <command>' } });
            return;
          }
          const { execSync } = await import('child_process');
          try {
            const output = execSync(cmd as string, { encoding: 'utf-8', timeout: 10000 });
            res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `**Command output:**\n\`\`\`\n${output.slice(0, 1500)}\n\`\`\`` } });
          } catch (err: any) {
            res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `❌ Command failed: ${err.message?.slice(0, 200) || String(err)}` } });
          }
          return;
        }

        if (subcommand === 'run') {
          const requirement = options?.[0]?.options?.find((o: any) => o.name === 'requirement')?.value;
          if (!requirement || !String(requirement).trim()) {
            res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: 'Usage: /studio run <requirement>' } });
            return;
          }
          try {
            const { triggerRequirement } = await import('./command-runner.js');
            const result = await triggerRequirement(String(requirement).trim());
            res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: result } });
          } catch (err: any) {
            res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `❌ Failed to submit: ${err.message?.slice(0, 300) || String(err)}` } });
          }
          return;
        }

        if (subcommand === 'progress') {
          try {
            const fs = await import('fs');
            const path = await import('path');
            const os = await import('os');
            const WORKTREES_DIR = process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');

            const runningExecs = await prisma.goalExecution.findMany({
              where: { status: 'running' },
              orderBy: { createdAt: 'desc' } as any,
              take: 5,
              select: { id: true, goalId: true, stepIndex: true, agentType: true, startedAt: true },
            });

            if (runningExecs.length === 0) {
              res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: 'No running executions.' } });
              return;
            }

            const lines: string[] = ['**Running Executions**', ''];
            for (const exec of runningExecs) {
              const elapsed = exec.startedAt
                ? `${Math.round((Date.now() - new Date(exec.startedAt).getTime()) / 60000)}m ago`
                : 'unknown';

              // Read .progress.json from worktree
              let progressInfo = 'No progress data';
              try {
                const progressPath = path.join(WORKTREES_DIR, exec.id, '.progress.json');
                if (fs.existsSync(progressPath)) {
                  const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
                  const step = progress.currentStep || 'starting';
                  const completed = progress.completedSteps?.length || 0;
                  const tests = progress.testResults
                    ? `${progress.testResults.passed || 0}p/${progress.testResults.failed || 0}f/${progress.testResults.total || 0}t`
                    : 'no tests';
                  const sessions = progress.sessionCount || '?';
                  progressInfo = `\`${step}\` | completed: ${completed} | tests: ${tests} | sessions: ${sessions}`;
                }
              } catch (e) {
                logger.error({ error: String(e) }, '[Discord] Failed to read progress file');
              }

              lines.push(`**${exec.id.slice(0, 8)}** step=${exec.stepIndex} goal=${exec.goalId.slice(0, 8)} ${elapsed}`);
              lines.push(`  ${progressInfo}`);
              lines.push('');
            }

            lines.push('Use `/studio stop <executionId>` to stop an execution.');
            res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: lines.join('\n') } });
          } catch (err: any) {
            res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `❌ Error reading progress: ${err.message?.slice(0, 300) || String(err)}` } });
          }
          return;
        }

        if (subcommand === 'stop') {
          const executionId = options?.[0]?.options?.find((o: any) => o.name === 'execution_id')?.value;
          if (!executionId || !String(executionId).trim()) {
            res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: 'Usage: /studio stop <executionId>' } });
            return;
          }
          const eid = String(executionId).trim();

          try {
            const exec = await prisma.goalExecution.findUnique({ where: { id: eid } });
            if (!exec) {
              // Try partial match
              const match = await prisma.goalExecution.findFirst({
                where: { id: { startsWith: eid } },
                select: { id: true, status: true },
              });
              if (match) {
                if (match.status !== 'running' && match.status !== 'pending') {
                  res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `Cannot stop execution with status: ${match.status}` } });
                  return;
                }
                await prisma.goalExecution.update({
                  where: { id: match.id },
                  data: { status: 'failed', error: 'Stopped by user via Discord' },
                });
                // Try to kill running child process
                const { agentExecutor } = await import('@dommaker/studio-agent');
                await agentExecutor.stop(match.id);
                // Publish event
                eventStore.publish('events:goal-execution', JSON.stringify({
                  event_type: 'goal-execution.updated',
                  data: { executionId: match.id, status: 'failed', error: 'Stopped by user via Discord' },
                })).catch(() => {});
                res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `✅ Stopped execution \`${match.id.slice(0, 8)}\`` } });
                return;
              }
              res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `Execution not found: \`${eid}\`` } });
              return;
            }

            if (exec.status !== 'running' && exec.status !== 'pending') {
              res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `Cannot stop execution with status: ${exec.status}` } });
              return;
            }

            await prisma.goalExecution.update({
              where: { id: exec.id },
              data: { status: 'failed', error: 'Stopped by user via Discord' },
            });

            // Try to kill running child process
            const { agentExecutor } = await import('@dommaker/studio-agent');
            await agentExecutor.stop(exec.id);

            // Publish event so GoalScheduler picks up the change
            eventStore.publish('events:goal-execution', JSON.stringify({
              event_type: 'goal-execution.updated',
              data: { executionId: exec.id, status: 'failed', error: 'Stopped by user via Discord' },
            })).catch(() => {});

            res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `✅ Stopped execution \`${exec.id.slice(0, 8)}\`` } });
          } catch (err: any) {
            res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `❌ Failed to stop: ${err.message?.slice(0, 300) || String(err)}` } });
          }
          return;
        }
      }

      res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `Unknown command: /${name} ${subcommand}` } });
    } catch (error) {
      res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `❌ Error: ${String(error).slice(0, 500)}` } });
    }
    return;
  }

  // 按钮点击处理
  if (body.type === InteractionType.MESSAGE_COMPONENT && body.data?.component_type === ComponentType.BUTTON) {
    const customId = body.data.custom_id as string;
    const parts = customId.split(':');
    const action = parts[0];
    const targetId = parts[1];

    logger.info({ action, targetId }, '[Discord] Button clicked');

    try {
      if (action === 'confirm' || action === 'reject') {
        logger.info({ action, targetId }, '[Discord] Meeting action ignored (meeting module removed)');
        res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `会议操作已忽略（Meeting 模块已移除）` } });
        return;
      }

      if (action === 'retry') {
        const extraRounds = parseInt(parts[2] || '2', 10);
        await prisma.goalExecution.update({
          where: { id: targetId },
          data: {
            status: 'pending',
            input: { resumeAfterRetry: true, extraRounds } as any,
          },
        });
        res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `🔁 已重置，再给 ${extraRounds} 轮` } });
        return;
      }

      if (action === 'retry-new') {
        await prisma.goalExecution.update({
          where: { id: targetId },
          data: {
            status: 'pending',
            input: JSON.stringify({ resumeAfterRetry: true, freshPrompt: true }),
          },
        });
        res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `🔄 已重置，换了新方向` } });
        return;
      }

      if (action === 'abandon') {
        await prisma.goalExecution.update({
          where: { id: targetId },
          data: { status: 'failed', error: 'Abandoned by user via Discord' },
        });
        res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `❌ 已放弃` } });
        return;
      }

      res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `⚠️ 未知操作: ${action}` } });
    } catch (error) {
      res.json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `❌ 处理失败: ${String(error)}` } });
    }
    return;
  }

  res.status(400).send('Unknown interaction type');
});

export default router;
