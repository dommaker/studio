import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateExecutionRepo } from '../execution-repo-policy.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-repo-policy-'));
const repoDir = path.join(tmpRoot, 'repo');
fs.mkdirSync(repoDir);
const originalRoots = process.env.PMO_GIT_REPO_ROOTS;

beforeEach(() => {
  process.env.PMO_GIT_REPO_ROOTS = tmpRoot;
});

afterAll(() => {
  if (originalRoots === undefined) delete process.env.PMO_GIT_REPO_ROOTS;
  else process.env.PMO_GIT_REPO_ROOTS = originalRoots;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('validateExecutionRepo', () => {
  it('PMO 与 channel.defaultPath 共用允许根和目录约束', () => {
    expect(validateExecutionRepo(repoDir)).toBeNull();
    expect(validateExecutionRepo('/etc')).toContain('existing directory under an allowed root');
    expect(validateExecutionRepo(path.join(tmpRoot, 'missing'))).not.toBeNull();
  });
});
