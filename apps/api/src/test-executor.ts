import { agentExecutor } from '@dommaker/studio-agent';
import { prisma } from '@dommaker/studio-prisma';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

async function main() {
  console.log('=== Direct Executor Test ===');

  // Find an unassigned execution (child WorkUnit)
  const execs = await prisma.workUnit.findMany({
    where: { status: 'unassigned', parentId: { not: null } },
    take: 1,
    orderBy: { createdAt: 'desc' },
  });

  if (execs.length === 0) {
    console.log('No unassigned executions. Creating test Goal...');

    const acGroup = { id: 'test', acs: ['Create /tmp/test-result.txt with content "TEST PASSED"'], files: ['/tmp/test-result.txt'], implementationNotes: 'Run: echo "TEST PASSED" > /tmp/test-result.txt', gotchas: ['Strictly one-line shell command, do NOT create projects'] };

    const goal = await prisma.workUnit.create({
      data: {
        type: 'task',
        scope: 'Test',
        status: 'active',
        metadata: JSON.stringify({
          description: 'test',
          plan: {
            status: 'approved',
            steps: [{
              index: 0, title: 'test', description: 'test', agentType: 'claude',
              input: { taskType: 'sub-agent', acGroup, model: 'fast' },
              dependencies: [], estimatedDuration: '2m'
            }],
            reasoning: 'test',
            version: 1,
          },
        }),
      }
    });

    const exec = await prisma.workUnit.create({
      data: {
        type: 'task',
        parentId: goal.id,
        scope: 'test-step-0',
        status: 'unassigned',
        metadata: JSON.stringify({
          stepIndex: 0,
          agentType: 'claude',
          input: { taskType: 'sub-agent', acGroup, model: 'fast' },
        }),
      }
    });

    console.log(`Created test Goal: ${goal.id}`);
    console.log(`Created test Execution: ${exec.id}`);

    const result = await agentExecutor.execute({
      id: exec.id,
      executionId: exec.id,
      agentType: 'claude',
      model: 'fast',
      prompt: 'Create /tmp/test-result.txt with "TEST PASSED". Use echo command only.',
      parameters: {
        goalId: goal.id,
        acGroup,
        hasWorktree: true,
      },
    });

    console.log('Result:', JSON.stringify({ success: result.success, error: result.error?.slice(0, 200) }, null, 2));
    console.log('Worktree:', result.worktree);
  }
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
