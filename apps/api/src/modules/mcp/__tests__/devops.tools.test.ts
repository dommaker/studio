/**
 * publishPackage 安全收口测试（2026-08-25）
 * 核心断言：bumpType 白名单 fail-fast —— 注入 payload 在任何 exec 之前被拦。
 */
import { describe, it, expect } from 'vitest';
import { devopsTools } from '../devops.tools.js';

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
