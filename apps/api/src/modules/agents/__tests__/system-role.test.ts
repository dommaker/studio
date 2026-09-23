/**
 * isSystemRole 断言单测（#631）——「是不是系统角色」的唯一判定点。
 * 覆盖：kind 字段直读 + 历史无字段记录按 name==='studio' 兜底。
 */
import { describe, it, expect } from 'vitest';
import { isSystemRole, STUDIO_ROLE_NAME } from '../system-role.js';

describe('isSystemRole', () => {
  it('kind=system → true（不看 name）', () => {
    expect(isSystemRole({ name: 'ops-bot', kind: 'system' })).toBe(true);
  });

  it('kind=system 且 name=studio → true', () => {
    expect(isSystemRole({ name: STUDIO_ROLE_NAME, kind: 'system' })).toBe(true);
  });

  it('kind=user → false（即使 name 恰好叫 studio——保留名由 create/update 拦截，identity 以 kind 为准）', () => {
    expect(isSystemRole({ name: STUDIO_ROLE_NAME, kind: 'user' })).toBe(false);
    expect(isSystemRole({ name: 'dev', kind: 'user' })).toBe(false);
  });

  it('历史无 kind 字段记录：name=studio 兜底 → true', () => {
    expect(isSystemRole({ name: STUDIO_ROLE_NAME })).toBe(true);
  });

  it('历史无 kind 字段记录：其他 name → false', () => {
    expect(isSystemRole({ name: 'dev' })).toBe(false);
  });
});
