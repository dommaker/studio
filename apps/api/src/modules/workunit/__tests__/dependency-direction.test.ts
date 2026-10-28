/**
 * ARCH-02：WorkUnit 核心不得反向依赖上层编排模块。
 * 静态、type-only、动态 import 都算出边；跨域效果必须走 workunit-ports。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WORKUNIT_DIR = path.resolve(__dirname, '..');
const FORBIDDEN = ['pmo', 'channels', 'requirements', 'agent-loop', 'agents', 'ops', 'audit-logs'];
const EDGE_RE = new RegExp(`(?:from|import\\()\\s*['"]\\.\\./(?:${FORBIDDEN.join('|')})/`);

function productionFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : productionFiles(file);
    return /\.ts$/.test(entry.name) ? [file] : [];
  });
}

describe('ARCH-02 WorkUnit 依赖方向', () => {
  it('workunit 生产代码没有指向 pmo/channels/requirements/agent-loop/agents/ops/audit-logs 的出边', () => {
    const violations = productionFiles(WORKUNIT_DIR).flatMap(file => {
      const content = fs.readFileSync(file, 'utf8');
      return EDGE_RE.test(content) ? [path.relative(WORKUNIT_DIR, file)] : [];
    });
    expect(violations).toEqual([]);
  });

  it('独立验证能力下沉到 core，AgentLoop 只保留兼容出口', () => {
    expect(fs.existsSync(path.resolve(WORKUNIT_DIR, '../../core/wu-verification.ts'))).toBe(true);
  });
});
