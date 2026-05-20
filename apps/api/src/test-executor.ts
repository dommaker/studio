import { agentExecutor } from '@dommaker/studio-agent';
import { prisma } from '@dommaker/studio-prisma';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

async function main() {
  console.log('=== Direct Executor Test ===');
  
  // Find a pending GoalExecution
  const execs = await prisma.goalExecution.findMany({
    where: { status: 'pending' },
    take: 1,
    orderBy: { createdAt: 'desc' },
  });
  
  if (execs.length === 0) {
    console.log('No pending executions. Creating test Goal...');
    let company = await prisma.company.findFirst();
    if (!company) company = await prisma.company.create({ data: { name: 'Test' } });
    
    const goal = await prisma.goal.create({
      data: { title: 'Test', description: 'test', companyId: company.id, status: 'executing' }
    });
    
    const plan = await prisma.goalPlan.create({
      data: {
        goalId: goal.id,
        steps: JSON.stringify([{
          index: 0, title: 'test', description: 'test', agentType: 'claude',
          input: { taskType: 'sub-agent', acGroup: { id: 'test', acs: ['Create /tmp/test-result.txt with content "TEST PASSED"'], files: ['/tmp/test-result.txt'], implementationNotes: 'Run: echo "TEST PASSED" > /tmp/test-result.txt. Then verify file exists with correct content.', codePatterns: [], gotchas: ['Do not create projects or subdirectories. This is a one-line shell command.'], dependencies: [] }, model: 'fast' },
          dependencies: [], estimatedDuration: '2m'
        }]),
        reasoning: 'test',
        version: 1,
        status: 'approved',
      }
    });

    const exec = await prisma.goalExecution.create({
      data: {
        goalId: goal.id, planId: plan.id, stepIndex: 0, status: 'pending',
        agentType: 'claude',
        input: JSON.stringify({ taskType: 'sub-agent', acGroup: { id: 'test', acs: ['Create /tmp/test-result.txt with content "TEST PASSED"'], files: ['/tmp/test-result.txt'], implementationNotes: 'Run: echo "TEST PASSED" > /tmp/test-result.txt', gotchas: ['Strictly one-line shell command, do NOT create projects'] }, model: 'fast' }),
      }
    });

    console.log(`Created test Goal: ${goal.id}`);
    console.log(`Created test Execution: ${exec.id}`);

    const acGroup = { id: 'test', acs: ['Create /tmp/test-result.txt with content "TEST PASSED"'], files: ['/tmp/test-result.txt'], implementationNotes: 'Run: echo "TEST PASSED" > /tmp/test-result.txt. Then verify.', codePatterns: [], gotchas: ['Do NOT create projects or subdirectories. This is a single shell command.'] };
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
