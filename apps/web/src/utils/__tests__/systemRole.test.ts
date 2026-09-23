// isSystemRole（web 侧）单测 — #631：系统角色身份判定唯一断言，
// kind 字段直读 + 历史无字段记录按 name==='studio' 兜底（与服务端 system-role.ts 同口径）。
import { describe, it, expect } from 'vitest';
import { isSystemRole } from '../systemRole';

describe('isSystemRole (web)', () => {
  it('kind=system → true（不看 name）', () => {
    expect(isSystemRole({ name: 'ops-bot', kind: 'system' })).toBe(true);
  });

  it('kind=user → false', () => {
    expect(isSystemRole({ name: 'studio', kind: 'user' })).toBe(false);
    expect(isSystemRole({ name: 'dev', kind: 'user' })).toBe(false);
  });

  it('历史无 kind 字段：name=studio 兜底 → true，其他 name → false', () => {
    expect(isSystemRole({ name: 'studio' })).toBe(true);
    expect(isSystemRole({ name: 'dev' })).toBe(false);
  });
});
