/**
 * PMO gitRepo 白名单校验（2026-08-25 安全收口）
 *
 * validateGitRepo：path.resolve 后必须落在允许的根目录
 * （PMO_GIT_REPO_ROOTS 冒号分隔多根，缺省 /root/projects）之下，
 * 且必须是已存在的目录。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateGitRepo } from '../routes.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-repo-roots-'));
const repoDir = path.join(tmpRoot, 'studio');
fs.mkdirSync(repoDir, { recursive: true });

const ORIGINAL_ENV = process.env.PMO_GIT_REPO_ROOTS;

beforeEach(() => {
  process.env.PMO_GIT_REPO_ROOTS = tmpRoot;
});

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PMO_GIT_REPO_ROOTS;
  else process.env.PMO_GIT_REPO_ROOTS = ORIGINAL_ENV;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('validateGitRepo（PMO gitRepo 白名单）', () => {
  it('接受允许根之下的已存在目录', () => {
    expect(validateGitRepo(repoDir)).toBeNull();
    // 冗余 segments resolve 后仍落在根下
    expect(validateGitRepo(path.join(tmpRoot, '.', 'studio'))).toBeNull();
  });

  it('拒绝根外路径（/etc）', () => {
    const err = validateGitRepo('/etc');
    expect(err).not.toBeNull();
    expect(err).toContain(tmpRoot);
  });

  it('拒绝 .. 逃逸（resolve 后落在根外）', () => {
    expect(validateGitRepo(path.join(tmpRoot, '..', '..', 'etc'))).not.toBeNull();
  });

  it('拒绝根下不存在的路径', () => {
    expect(validateGitRepo(path.join(tmpRoot, 'no-such-dir'))).not.toBeNull();
  });

  it('拒绝根下已存在但非目录的路径', () => {
    const f = path.join(tmpRoot, 'a-file');
    fs.writeFileSync(f, 'x');
    expect(validateGitRepo(f)).not.toBeNull();
  });
});
