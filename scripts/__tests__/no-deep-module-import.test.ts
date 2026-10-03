/**
 * no-deep-module-import — 模块边界 eslint 规则单元测试（P2-c）
 * findDeepModuleImport 纯函数 + RuleTester 规则行为
 */
import { describe, it, expect } from 'vitest';
import { RuleTester } from 'eslint';
import rule, { findDeepModuleImport } from '../eslint-rules/no-deep-module-import.mjs';

const F = 'apps/api/src/modules/channels/channel.service.ts';

describe('findDeepModuleImport', () => {
  it('跨模块深路径 → 违规', () => {
    expect(findDeepModuleImport(F, '../workunit/workunit.service.js'))
      .toEqual({ module: 'workunit', deepPath: 'workunit.service.js' });
    expect(findDeepModuleImport('apps/api/src/modules/channels/sub/x.ts', '../../agents/loop/agent-loop.js'))
      .toEqual({ module: 'agents', deepPath: 'loop/agent-loop.js' });
    // 模块外基础设施深 import 同样违规（白名单靠 config files 块豁免，规则本身不认文件角色）
    expect(findDeepModuleImport('apps/api/src/bootstrap/services.ts', '../modules/pmo/routes.js'))
      .toEqual({ module: 'pmo', deepPath: 'routes.js' });
  });
  it('模块根 barrel / 模块内部 / 非模块路径 → 合法', () => {
    expect(findDeepModuleImport(F, '../workunit/index.js')).toBeNull();
    expect(findDeepModuleImport(F, '../workunit')).toBeNull(); // 目录形态解析到 index
    expect(findDeepModuleImport(F, './routing.js')).toBeNull(); // 模块内部
    expect(findDeepModuleImport('apps/api/src/modules/channels/sub/x.ts', '../sibling.js')).toBeNull();
    expect(findDeepModuleImport(F, '../../core/store.js')).toBeNull(); // core 不是模块
    expect(findDeepModuleImport(F, '@dommaker/studio-shared')).toBeNull(); // 包 import
    expect(findDeepModuleImport('apps/api/src/app.ts', './modules/agents/index.js')).toBeNull();
  });
});

describe('rule（RuleTester）', () => {
  const tester = new RuleTester({
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
  });
  tester.run('no-deep-module-import', rule, {
    valid: [
      { code: `import { WorkUnitService } from '../workunit/index.js';`, filename: F },
      { code: `import { x } from './local.js';`, filename: F },
      { code: `const m = await import('../workunit/index.js');`, filename: F },
      { code: `import { logger } from '@dommaker/studio-shared';`, filename: F },
    ],
    invalid: [
      {
        code: `import { WorkUnitService } from '../workunit/workunit.service.js';`,
        filename: F,
        errors: [{ messageId: 'deepImport' }],
      },
      {
        code: `export { x } from '../pmo/project.service.js';`,
        filename: F,
        errors: [{ messageId: 'deepImport' }],
      },
      {
        code: `const m = await import('../agents/loop/agent-loop.js');`,
        filename: F,
        errors: [{ messageId: 'deepImport' }],
      },
      {
        code: `const { W } = require('../workunit/workunit.service.js');`,
        filename: F,
        errors: [{ messageId: 'deepImport' }],
      },
    ],
  });
  it('RuleTester 断言通过', () => {
    expect(true).toBe(true); // RuleTester 失败会直接抛错
  });
});
