/**
 * core/system-role — 系统角色身份断言测试（#631 / P2-c 下沉）
 */
import { describe, it, expect } from 'vitest';
import { STUDIO_ROLE_NAME, isSystemRole } from '../system-role.js';

describe('isSystemRole', () => {
  it('kind=system → true', () => {
    expect(isSystemRole({ name: 'whatever', kind: 'system' })).toBe(true);
  });
  it('kind=user → false（即使叫 studio）', () => {
    expect(isSystemRole({ name: 'studio', kind: 'user' })).toBe(false);
  });
  it('历史无 kind 记录按 name=studio 兜底', () => {
    expect(isSystemRole({ name: STUDIO_ROLE_NAME })).toBe(true);
    expect(isSystemRole({ name: 'dev' })).toBe(false);
  });
});
