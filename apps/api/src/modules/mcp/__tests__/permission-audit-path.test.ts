/**
 * P0 修复 5: permission.service 审计日志路径隔离
 *
 * vitest（VITEST 已设置）下 AUDIT_PATH 改写到 os.tmpdir()/studio-test-logs/mcp-audit-logs.jsonl，
 * 不再写生产 ~/.studio/mcp-audit-logs.jsonl。
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { mcpPermissionService } from '../permission.service.js';

const ISOLATED_AUDIT = path.join(os.tmpdir(), 'studio-test-logs', 'mcp-audit-logs.jsonl');
const PROD_AUDIT = path.join(os.homedir(), '.studio', 'mcp-audit-logs.jsonl');

describe('permission.service 审计路径隔离 (P0 修复 5)', () => {
  afterEach(() => {
    fs.rmSync(ISOLATED_AUDIT, { force: true });
  });

  it('logAudit 写入隔离目录，不写生产路径', async () => {
    fs.rmSync(ISOLATED_AUDIT, { force: true });

    await mcpPermissionService.logAudit({
      toolName: 'iso_probe_tool_xq9',
      roleId: 'tester',
      duration: 1,
      success: true,
    });

    expect(fs.existsSync(ISOLATED_AUDIT)).toBe(true);
    const rows = fs.readFileSync(ISOLATED_AUDIT, 'utf-8')
      .trim().split('\n').map(l => JSON.parse(l));
    expect(rows.some(r => r.toolName === 'iso_probe_tool_xq9')).toBe(true);

    // 生产文件（若存在）不含本条测试记录
    if (fs.existsSync(PROD_AUDIT)) {
      expect(fs.readFileSync(PROD_AUDIT, 'utf-8')).not.toContain('iso_probe_tool_xq9');
    }
  });
});
