/**
 * publishPackage 安全收口测试（2026-08-25）
 * 核心断言：bumpType 白名单 fail-fast —— 注入 payload 在任何 exec 之前被拦。
 * #425：dist 校验改调 harness 发布物自检（verifyReleaseArtifacts），不再硬编码清单。
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { devopsTools } from '../devops.tools.js';

const execFileSyncMock = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...(args as [])) };
});

const verifyArtifactsMock = vi.fn();
vi.mock('@dommaker/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/harness')>();
  return { ...actual, verifyReleaseArtifacts: (...args: unknown[]) => verifyArtifactsMock(...args) };
});

const publishPackage = devopsTools.find((t) => t.name === 'publishPackage')!;

describe('publishPackage bumpType 白名单', () => {
  it('拒绝 shell 注入 payload（不执行任何命令）', async () => {
    const result: any = await publishPackage.handler({
      packagePath: '/nonexistent',
      bumpType: 'patch; touch /tmp/pwned-devops-tools;',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid bumpType/);
  });

  it('拒绝非字符串 bumpType', async () => {
    const result: any = await publishPackage.handler({
      packagePath: '/nonexistent',
      bumpType: { $gt: '' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid bumpType/);
  });

  it.each(['patch', 'minor', 'major'])('合法 bumpType=%s 通过白名单（在路径校验处失败，证明越过了白名单）', async (bumpType) => {
    const result: any = await publishPackage.handler({ packagePath: '/nonexistent', bumpType });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Not a package/);
  });

  it('bumpType 缺省按 patch 处理', async () => {
    const result: any = await publishPackage.handler({ packagePath: '/nonexistent' });
    expect(result.error).toMatch(/Not a package/);
  });
});

describe('publishPackage dist 校验调 harness 发布物自检（#425）', () => {
  let tmpPkg: string;

  function setupExecMock() {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'remote') return 'git@github.com:dommaker/fake.git\n';
      if (cmd === 'git' && args[0] === 'status') return '';
      if (cmd === 'npx' && args[0] === 'tsc') return '';
      return '';
    });
  }

  it('缺失项：step fail 且报出 harness 自检的 missing 清单', async () => {
    tmpPkg = fs.mkdtempSync(path.join(os.tmpdir(), 'devops-publish-selfcheck-'));
    fs.writeFileSync(path.join(tmpPkg, 'package.json'), JSON.stringify({ name: 'fake-pkg', version: '0.0.1' }));
    setupExecMock();
    verifyArtifactsMock.mockReturnValue({ ok: false, pkgRoot: tmpPkg, checked: ['dist/index.js', 'dist/x.js'], missing: ['dist/x.js'] });

    const result: any = await publishPackage.handler({ packagePath: tmpPkg, bumpType: 'patch', dryRun: 'true' });
    expect(verifyArtifactsMock).toHaveBeenCalledWith(tmpPkg);
    const step = result.steps.find((s: any) => s.step.startsWith('dist verify'));
    expect(step.status).toBe('fail');
    expect(step.step).toContain('1 missing');
    expect(step.output).toBe('dist/x.js');
    fs.rmSync(tmpPkg, { recursive: true, force: true });
  });

  it('全量齐备：step ok 带清单规模（无硬编码文件清单）', async () => {
    tmpPkg = fs.mkdtempSync(path.join(os.tmpdir(), 'devops-publish-selfcheck-'));
    fs.writeFileSync(path.join(tmpPkg, 'package.json'), JSON.stringify({ name: 'fake-pkg', version: '0.0.1' }));
    setupExecMock();
    const checked = Array.from({ length: 14 }, (_, i) => `dist/f${i}.js`);
    verifyArtifactsMock.mockReturnValue({ ok: true, pkgRoot: tmpPkg, checked, missing: [] });

    const result: any = await publishPackage.handler({ packagePath: tmpPkg, bumpType: 'patch', dryRun: 'true' });
    expect(verifyArtifactsMock).toHaveBeenCalledWith(tmpPkg);
    const step = result.steps.find((s: any) => s.step.startsWith('dist verify'));
    expect(step.status).toBe('ok');
    expect(step.step).toContain('14');
    fs.rmSync(tmpPkg, { recursive: true, force: true });
  });
});
