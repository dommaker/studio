/**
 * DeployAgent retry + merge failure event tests
 *
 * AC-1: pushToOrigin pre-flight ls-remote is INSIDE retry loop (not outside)
 * AC-2: Merge failure path emits deploy.completed event via eventBus
 * AC-3: Merge failure path writes StudioEvent with failureClass in payload
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SOURCE_FILE = path.resolve(__dirname, '../deploy-agent.service.ts');

function readSource(): string {
  return fs.readFileSync(SOURCE_FILE, 'utf-8');
}

/** Extract method body of pushToOrigin using brace-depth counting */
function extractPushToOriginBody(src: string): string {
  const startIdx = src.indexOf('private async pushToOrigin');
  expect(startIdx, 'pushToOrigin method not found').toBeGreaterThan(-1);
  const braceStart = src.indexOf('{', startIdx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        return src.substring(braceStart + 1, i);
      }
    }
  }
  throw new Error('Could not find end of pushToOrigin method');
}

describe('DeployAgent push pre-flight inside retry loop', () => {
  // AC-1: ls-remote must be inside the for loop, not before it
  it('AC-1.1: git ls-remote appears AFTER "for (let attempt" in pushToOrigin', () => {
    const src = readSource();
    const methodBody = extractPushToOriginBody(src);

    // Find position of for-loop and ls-remote within the method
    const forLoopPos = methodBody.indexOf('for (let attempt');
    const lsRemotePos = methodBody.indexOf('git ls-remote');

    expect(forLoopPos, 'for-loop not found in pushToOrigin').toBeGreaterThan(-1);
    expect(lsRemotePos, 'git ls-remote not found in pushToOrigin').toBeGreaterThan(-1);

    // ls-remote must come AFTER the for-loop starts (inside the loop)
    expect(lsRemotePos).toBeGreaterThan(forLoopPos);
  });

  it('AC-1.2: No early return before the retry loop in pushToOrigin', () => {
    const src = readSource();
    const methodBody = extractPushToOriginBody(src);

    // Extract everything before the for-loop
    const forLoopPos = methodBody.indexOf('for (let attempt');
    const beforeLoop = methodBody.substring(0, forLoopPos);

    // No "return" statement before the loop — pre-flight failure should not abort
    const hasEarlyReturn = /\breturn\b/.test(beforeLoop);
    expect(hasEarlyReturn, 'Found early return before retry loop — pre-flight aborts instead of retrying').toBe(false);
  });

  it('AC-1.3: ls-remote is inside try block within the for-loop', () => {
    const src = readSource();
    const methodBody = extractPushToOriginBody(src);

    // The for-loop body should contain both ls-remote and push inside a try
    const forLoopPos = methodBody.indexOf('for (let attempt');
    const loopBody = methodBody.substring(forLoopPos);

    // Both ls-remote and push should be in the loop body
    expect(loopBody).toContain('git ls-remote');
    expect(loopBody).toContain('git push origin');

    // ls-remote should come before push in the loop body (pre-flight then push)
    const lsRemoteInLoop = loopBody.indexOf('git ls-remote');
    const pushInLoop = loopBody.indexOf('git push origin');
    expect(lsRemoteInLoop).toBeLessThan(pushInLoop);
  });
});

describe('DeployAgent merge failure event emission', () => {
  // AC-2: merge failure path emits deploy.completed event
  it('AC-2.1: eventBus.publish deploy.completed exists in merge failure path', () => {
    const src = readSource();

    // Find the merge failure block: "if (!mergeResult.success)"
    const mergeFailMatch = src.match(/if \(!mergeResult\.success\) \{([\s\S]*?)return mergeResult;/);
    expect(mergeFailMatch, 'merge failure block not found').toBeTruthy();
    const mergeFailBlock = mergeFailMatch![1];

    // Must contain eventBus.publish with deploy.completed
    expect(mergeFailBlock).toContain('eventBus.publish');
    expect(mergeFailBlock).toContain('deploy.completed');
  });

  // AC-3: merge failure path writes StudioEvent with failureClass
  it('AC-3.1: prisma.studioEvent.create exists in merge failure path', () => {
    const src = readSource();

    const mergeFailMatch = src.match(/if \(!mergeResult\.success\) \{([\s\S]*?)return mergeResult;/);
    expect(mergeFailMatch).toBeTruthy();
    const mergeFailBlock = mergeFailMatch![1];

    expect(mergeFailBlock).toContain('prisma.studioEvent.create');
  });

  it('AC-3.2: StudioEvent payload includes failureClass from classifyFailureAction', () => {
    const src = readSource();

    const mergeFailMatch = src.match(/if \(!mergeResult\.success\) \{([\s\S]*?)return mergeResult;/);
    expect(mergeFailMatch).toBeTruthy();
    const mergeFailBlock = mergeFailMatch![1];

    // Must call classifyFailureAction and include failureClass in payload
    expect(mergeFailBlock).toContain('classifyFailureAction');
    expect(mergeFailBlock).toContain('failureClass');
  });

  it('AC-3.3: StudioEvent payload type is merge-failed', () => {
    const src = readSource();

    const mergeFailMatch = src.match(/if \(!mergeResult\.success\) \{([\s\S]*?)return mergeResult;/);
    expect(mergeFailMatch).toBeTruthy();
    const mergeFailBlock = mergeFailMatch![1];

    expect(mergeFailBlock).toContain('merge-failed');
  });

  it('AC-3.4: StudioEvent payload includes timings', () => {
    const src = readSource();

    const mergeFailMatch = src.match(/if \(!mergeResult\.success\) \{([\s\S]*?)return mergeResult;/);
    expect(mergeFailMatch).toBeTruthy();
    const mergeFailBlock = mergeFailMatch![1];

    expect(mergeFailBlock).toContain('timings');
  });
});
