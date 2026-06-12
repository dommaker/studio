import { describe, test, expect } from 'vitest';
import { extractAcs } from '../post-eval-agent.service.js';

describe('extractAcs', () => {
  test('extracts checkbox ACs (DB format)', () => {
    const content = `
## Some Section

- [ ] Add JWT auth
- [x] Fix login bug
- [ ] Update middleware
`;
    expect(extractAcs(content)).toEqual([
      'Add JWT auth',
      'Fix login bug',
      'Update middleware',
    ]);
  });

  test('extracts bullet ACs from AC Groups section (SDD format)', () => {
    const content = `
## Summary

Some summary text

## AC Groups

### auth-group

- 在 auth.ts 中添加 JWT 验证中间件
- 修复 token 过期处理逻辑

**Files**: auth.ts, middleware.ts
**Dependencies**: []
`;
    expect(extractAcs(content)).toEqual([
      '在 auth.ts 中添加 JWT 验证中间件',
      '修复 token 过期处理逻辑',
    ]);
  });

  test('ignores bullet items outside AC Groups section', () => {
    const content = `
## Summary

- This is not an AC
- Neither is this

## AC Groups

### group-1

- This is an AC
`;
    expect(extractAcs(content)).toEqual([
      'This is an AC',
    ]);
  });

  test('ignores metadata lines in AC Groups section', () => {
    const content = `
## AC Groups

### group-1

- Real AC here

**Files**: some/file.ts
**Dependencies**: []
**Target Repo**: studio
`;
    expect(extractAcs(content)).toEqual([
      'Real AC here',
    ]);
  });

  test('returns empty for no ACs', () => {
    expect(extractAcs('no acs here')).toEqual([]);
  });

  test('handles mixed checkbox and bullet formats', () => {
    const content = `
- [x] Checkbox AC

## AC Groups

### group-1

- Bullet AC
`;
    expect(extractAcs(content)).toEqual([
      'Checkbox AC',
      'Bullet AC',
    ]);
  });
});
