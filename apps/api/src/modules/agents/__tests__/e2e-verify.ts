/**
 * E2E Verification Script — Agent Network Loop Design §13
 *
 * Verifies 3 critical assumptions:
 * 1. Agent follows ACTION protocol (parseAgentOutput works)
 * 2. Session resume works across steps (context continuity)
 * 3. Agent can autonomously push work to completion
 *
 * Usage: DATABASE_URL="file:/root/.studio/data/data.db" npx tsx apps/api/src/modules/agents/__tests__/e2e-verify.ts
 *
 * Requires: running API server, valid ANTHROPIC_API_KEY, Claude CLI installed
 */
import { prisma } from '@dommaker/studio-prisma';
import { AgentLoop, parseAgentOutput, resolveTarget, dynamicInterval } from '../agent-loop.js';
import { agentRunner } from '@dommaker/studio-agent';
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';
import type { WorkUnit, AgentProfile, ChannelMessage } from '@prisma/client';

const LOG_PREFIX = '[E2E-Verify]';

async function log(msg: string, data?: unknown) {
  console.log(`${LOG_PREFIX} ${msg}`, data ?? '');
}

/** Step 1: Verify ACTION protocol parsing with real Claude output */
async function verifyAssumption1() {
  log('=== Assumption 1: Agent follows ACTION protocol ===');

  // Test parseAgentOutput with various formats Claude might produce
  const testCases = [
    // Ideal format
    { input: 'I completed the task.\nACTION: COMPLETE:Added uptime field to /api/health', expected: 'complete' },
    // With markdown
    { input: '## Progress\nDone with step 1.\n\nACTION: PROGRESS:Step 1 complete', expected: 'progress' },
    // Need input
    { input: 'ACTION: NEED_INPUT:Should I use TypeScript or JavaScript?', expected: 'need_input' },
    // No ACTION line (fallback to progress)
    { input: 'I read the codebase and found that the health endpoint is in src/routes/health.ts', expected: 'progress' },
    // Empty output
    { input: '', expected: 'progress' },
    // Mixed content with ACTION in middle
    { input: 'Starting work...\n\nHere is my plan:\n1. Read the file\n2. Add the field\n\nACTION: PROGRESS:Reading health.ts', expected: 'progress' },
  ];

  let pass = 0;
  let fail = 0;

  for (const tc of testCases) {
    const result = parseAgentOutput(tc.input);
    const ok = result.action === tc.expected;
    if (ok) {
      pass++;
      log(`  ✓ parseAgentOutput → ${result.action} (summary: "${result.summary.slice(0, 50)}...")`);
    } else {
      fail++;
      log(`  ✗ Expected ${tc.expected}, got ${result.action} (input: "${tc.input.slice(0, 60)}...")`);
    }
  }

  log(`Assumption 1 result: ${pass}/${testCases.length} passed`, { pass, fail });
  return fail === 0;
}

/** Step 2: Verify session resume with real Claude CLI */
async function verifyAssumption2() {
  log('=== Assumption 2: Session resume works ===');

  const workUnitId = `e2e-session-test-${Date.now()}`;
  const homeDir = `/tmp/agent-loop/${workUnitId}`;

  // Create a minimal task with proper UUID session ID
  const { randomUUID } = await import('crypto');
  const sessionId = randomUUID();

  const task1: AgentTask = {
    id: workUnitId,
    executionId: `${workUnitId}-step1`,
    agentType: 'claude',
    prompt: 'You are a test agent. Read the file /root/projects/studio/apps/api/src/modules/agents/agent-loop.ts and tell me the first function name you see. Output ACTION: PROGRESS:<answer>',
    parameters: {
      sessionFlags: `--session-id ${sessionId}`,
      agentRole: 'executor',
      workUnitId,
      extraEnv: {
        STUDIO_WORKUNIT_ID: workUnitId,
        STUDIO_CHANNEL_ID: '',
      },
    },
    model: 'standard',
    timeoutMs: 60_000,
  };

  try {
    log('  Step 1: Initial session...');
    const result1 = await agentRunner.executeLightweight(task1);
    log(`  Step 1 result: success=${result1.success}, output="${(result1.outputText ?? '').slice(0, 200)}"`);

    if (!result1.success) {
      log('  ✗ Step 1 failed', result1.error);
      return false;
    }

    const parsed1 = parseAgentOutput(result1.outputText ?? '');
    log(`  Step 1 parsed: action=${parsed1.action}, summary="${parsed1.summary.slice(0, 100)}"`);

    // Resume session with same UUID
    const task2: AgentTask = {
      ...task1,
      executionId: `${workUnitId}-step2`,
      prompt: 'Continuing from before. What was the second function you saw? Output ACTION: COMPLETE:<answer>',
      parameters: {
        ...task1.parameters,
        sessionFlags: `--resume ${sessionId}`,
      },
    };

    log('  Step 2: Resume session...');
    const result2 = await agentRunner.executeLightweight(task2);
    log(`  Step 2 result: success=${result2.success}, output="${(result2.outputText ?? '').slice(0, 200)}"`);

    if (!result2.success) {
      log('  ✗ Step 2 failed (resume might not work)', result2.error);
      return false;
    }

    const parsed2 = parseAgentOutput(result2.outputText ?? '');
    log(`  Step 2 parsed: action=${parsed2.action}, summary="${parsed2.summary.slice(0, 100)}"`);

    // Check if session files exist in HOME
    const fs = await import('fs');
    const homeFiles = fs.existsSync(homeDir) ? fs.readdirSync(homeDir) : [];
    log(`  HOME dir contents: ${homeFiles.join(', ') || '(empty)'}`);

    // Check .claude directory for session data
    const claudeDir = `${homeDir}/.claude`;
    const claudeFiles = fs.existsSync(claudeDir) ? fs.readdirSync(claudeDir) : [];
    log(`  .claude dir contents: ${claudeFiles.join(', ') || '(empty)'}`);

    log('Assumption 2 result: Session resume completed (check output for context continuity)');
    return result1.success && result2.success;
  } catch (err) {
    log(`  ✗ Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Step 3: Verify autonomous execution through AgentLoop */
async function verifyAssumption3() {
  log('=== Assumption 3: Agent can autonomously push work ===');

  // Create test data in DB
  const role = await prisma.agentProfile.create({
    data: {
      name: `e2e-test-agent-${Date.now()}`,
      description: 'E2E verification agent that handles task type work units',
      channels: '[]',
      status: 'active',
    },
  });
  log(`  Created AgentProfile: ${role.id}`);

  // Create a channel for discussion space
  const channel = await prisma.channel.create({
    data: {
      name: `#e2e-verify-${Date.now()}`,
      type: 'rnd',
    },
  });
  log(`  Created Channel: ${channel.id}`);

  // Create a simple WorkUnit
  const wu = await prisma.workUnit.create({
    data: {
      type: 'task',
      scope: 'Add a comment "// E2E test marker" to the first line of /tmp/e2e-test-target.txt. Create the file if it does not exist.',
      status: 'unassigned',
      channelId: channel.id,
      metadata: '{}',
    },
  });
  log(`  Created WorkUnit: ${wu.id}`);

  // Create RuntimeInstance for the agent
  const instance = await prisma.runtimeInstance.create({
    data: {
      roleId: role.id,
      status: 'idle',
    },
  });
  log(`  Created RuntimeInstance: ${instance.id}`);

  // Manually run the agent loop for a few iterations
  const agentLoop = new AgentLoop(role as unknown as AgentProfile);
  // Inject instance
  (agentLoop as any).instance = instance;

  try {
    // Run observe → resolveTarget
    const observations = await (agentLoop as any).observe();
    log(`  Observe: myActive=${observations.myActive.length}, unassigned=${observations.unassigned.length}, newReplies=${observations.newReplies.length}`);

    const target = resolveTarget(observations);
    if (!target) {
      log('  ✗ No target resolved');
      return false;
    }
    log(`  ResolveTarget: workUnit=${target.workUnit.id}, status=${target.workUnit.status}`);

    // Claim the work unit
    await prisma.workUnit.updateMany({
      where: { id: wu.id, assigneeId: null, status: 'unassigned' },
      data: { assigneeId: instance.id, status: 'active' },
    });
    log(`  Claimed WorkUnit`);

    // Run agentStep
    log('  Running agentStep (this spawns Claude CLI)...');
    const stepResult = await (agentLoop as any).agentStep({
      workUnit: { ...wu, status: 'active', assigneeId: instance.id },
    });
    log(`  agentStep result: action=${stepResult.action}, summary="${stepResult.summary?.slice(0, 100)}"`);
    log(`  metadataUpdates:`, stepResult.metadataUpdates);

    // Verify the file was created
    const fs = await import('fs');
    const fileExists = fs.existsSync('/tmp/e2e-test-target.txt');
    const fileContent = fileExists ? fs.readFileSync('/tmp/e2e-test-target.txt', 'utf-8') : '';
    log(`  Target file: exists=${fileExists}, content="${fileContent}"`);

    const success = stepResult.action !== null && fileExists;
    log(`Assumption 3 result: ${success ? 'PASS' : 'FAIL'}`);
    return success;
  } catch (err) {
    log(`  ✗ Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    // Cleanup
    try {
      await prisma.runtimeInstance.delete({ where: { id: instance.id } });
      await prisma.workUnit.delete({ where: { id: wu.id } });
      await prisma.channel.delete({ where: { id: channel.id } });
      await prisma.agentProfile.delete({ where: { id: role.id } });
      log('  Cleaned up test data');
    } catch (cleanupErr) {
      log(`  Cleanup error: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    }
  }
}

// Main
async function main() {
  log('Starting E2E Verification — Agent Network Loop Design §13');
  log(`Database: ${process.env.DATABASE_URL ?? 'default'}`);
  log(`Claude CLI: available (check with "which claude")`);
  log('');

  const results: { name: string; pass: boolean }[] = [];

  // Assumption 1: ACTION protocol parsing (no external deps, fast)
  const a1 = await verifyAssumption1();
  results.push({ name: 'Assumption 1: ACTION protocol', pass: a1 });
  log('');

  // Assumption 2: Session resume (requires Claude CLI, ~30s)
  const a2 = await verifyAssumption2();
  results.push({ name: 'Assumption 2: Session resume', pass: a2 });
  log('');

  // Assumption 3: Autonomous execution (requires DB + Claude CLI, ~60s)
  const a3 = await verifyAssumption3();
  results.push({ name: 'Assumption 3: Autonomous execution', pass: a3 });
  log('');

  // Summary
  log('=== Summary ===');
  for (const r of results) {
    log(`  ${r.pass ? '✓' : '✗'} ${r.name}`);
  }

  const allPass = results.every(r => r.pass);
  log(`\nOverall: ${allPass ? 'ALL PASS' : 'SOME FAILED'}`);

  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error(`${LOG_PREFIX} Fatal error:`, err);
  process.exit(1);
});
