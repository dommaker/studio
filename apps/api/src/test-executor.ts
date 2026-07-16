import { agentExecutor } from '@dommaker/studio-agent';
import { WorkUnitService } from './modules/workunit/workunit.service.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const workUnitService = new WorkUnitService();

async function main() {
  console.log('=== Direct Executor Test ===');

  // Find an unassigned child WorkUnit
  const allUnassigned = await workUnitService.list({ status: 'unassigned' });
  const execs = allUnassigned.data.filter(e => e.parentId !== null);

  if (execs.length === 0) {
    console.log('No unassigned executions. Creating test WorkUnit...');

    const acGroup = { id: 'test', acs: ['Create /tmp/test-result.txt with content "TEST PASSED"'], files: ['/tmp/test-result.txt'], implementationNotes: 'Run: echo "TEST PASSED" > /tmp/test-result.txt', gotchas: ['Strictly one-line shell command, do NOT create projects'] };

    const goal = await workUnitService.create({
      type: 'task',
      scope: 'Test',
      status: 'active',
      metadata: {
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
      },
    });

    const exec = await workUnitService.create({
      type: 'task',
      parentId: goal.id,
      scope: 'test-step-0',
      status: 'unassigned',
      metadata: {
        stepIndex: 0,
        agentType: 'claude', taskInput: { taskType: 'sub-agent', acGroup, model: 'fast' },
      },
    });

    console.log(`Created test WorkUnit: ${goal.id}`);
    console.log(`Created test Execution: ${exec.id}`);

    const result = await agentExecutor.execute({
      id: exec.id,
      executionId: exec.id,
      provider: 'claude',
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
