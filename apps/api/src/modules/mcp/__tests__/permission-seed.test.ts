/**
 * seedDefaultPermissions 危险工具收口测试（2026-08-25）
 *
 * 背景：seed 原本给 8 个系统角色对全部 tool 写 allowed:true（含 publishPackage
 * 这种不可逆发布 + shell 面工具），且只增不改——旧部署的过度授权不会自愈。
 * 收口后：DANGEROUS_TOOLS 仅 PRIVILEGED_ROLES（admin/deploy）默认允许，
 * 其余角色默认拒绝，并把历史错误的 allowed:true 强制纠正为 false。
 *
 * 隔离：vitest setup（setup-isolated-data.setup.ts）已把 STUDIO_HOME 钉到临时目录，
 * PERMS_PATH 落在隔离数据根内，不触碰生产 ~/.studio。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { seedDefaultPermissions } from '../permission.service.js';

const permsPath = path.join(process.env.STUDIO_HOME!, 'mcp-permissions.json');

function readPerms(): Array<{ roleId: string; toolName: string; allowed: boolean }> {
  return JSON.parse(fs.readFileSync(permsPath, 'utf-8'));
}

beforeEach(() => {
  if (fs.existsSync(permsPath)) fs.unlinkSync(permsPath);
});

describe('seedDefaultPermissions 危险工具默认授权', () => {
  it('publishPackage 仅 admin/deploy 默认允许，其余系统角色默认拒绝', async () => {
    await seedDefaultPermissions(['publishPackage', 'listProjects']);
    const perms = readPerms();

    const allowedFor = (roleId: string, toolName: string) =>
      perms.find((p) => p.roleId === roleId && p.toolName === toolName)?.allowed;

    expect(allowedFor('admin', 'publishPackage')).toBe(true);
    expect(allowedFor('deploy', 'publishPackage')).toBe(true);
    for (const role of ['analyst', 'executor', 'reviewer', 'auditor', 'monitor', 'triage']) {
      expect(allowedFor(role, 'publishPackage')).toBe(false);
    }
    // 普通工具所有角色默认允许（行为不变）
    expect(allowedFor('executor', 'listProjects')).toBe(true);
    expect(allowedFor('analyst', 'listProjects')).toBe(true);
  });

  it('历史错误的 executor×publishPackage allowed:true 被强制纠正为 false', async () => {
    // 模拟旧部署 seed 出的过度授权记录
    fs.writeFileSync(
      permsPath,
      JSON.stringify([
        { id: '1', roleId: 'executor', toolName: 'publishPackage', allowed: true },
        { id: '2', roleId: 'admin', toolName: 'publishPackage', allowed: true },
        { id: '3', roleId: 'executor', toolName: 'listProjects', allowed: true },
      ]),
    );

    await seedDefaultPermissions(['publishPackage', 'listProjects']);
    const perms = readPerms();

    expect(perms.find((p) => p.roleId === 'executor' && p.toolName === 'publishPackage')?.allowed).toBe(false);
    // 特权角色与正常授权不受影响
    expect(perms.find((p) => p.roleId === 'admin' && p.toolName === 'publishPackage')?.allowed).toBe(true);
    expect(perms.find((p) => p.roleId === 'executor' && p.toolName === 'listProjects')?.allowed).toBe(true);
  });

  it('幂等：重复 seed 不重复添加记录', async () => {
    await seedDefaultPermissions(['publishPackage']);
    const first = readPerms().length;
    await seedDefaultPermissions(['publishPackage']);
    expect(readPerms().length).toBe(first);
  });
});
