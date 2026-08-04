/**
 * GEN-005 E2E 测试 - PMO 项目管理系统
 */

import { test, expect } from '@playwright/test';

const API_BASE = 'http://localhost:3001/api/v1';
const COMPANY_ID = 'cmo77h9qf0002vsqjikl1qul9'; // Test Company

test.describe('GEN-005 PMO 项目管理系统', () => {
  test.beforeAll(async () => {
    // 确保服务启动
    const res = await fetch(`${API_BASE}/pmo/okr?companyId=${COMPANY_ID}`);
    expect(res.ok).toBeTruthy();
  });

  test('AC-001: Project 创建 - PMO 号自动生成', async () => {
    const res = await fetch(`${API_BASE}/pmo/project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyId: COMPANY_ID,
        title: 'E2E 测试项目',
        description: '测试 PMO 号生成',
      }),
    });

    expect(res.ok).toBeTruthy();
    const data = await res.json();
    
    // 验证 PMO 号格式
    expect(data.pmoNumber).toMatch(/PM-\d{3}/);
    expect(data.status).toBe('pending');
    expect(data.progress).toBe(0);
  });

  test('AC-002: Project 列表查询', async () => {
    const res = await fetch(`${API_BASE}/pmo/project?companyId=${COMPANY_ID}&limit=10`);
    
    expect(res.ok).toBeTruthy();
    const data = await res.json();
    
    expect(data.data).toBeDefined();
    expect(Array.isArray(data.data)).toBeTruthy();
    expect(data.data.length).toBeGreaterThan(0);
  });

  test('AC-003: Project 详情查询（by id）', async () => {
    // 先获取列表
    const listRes = await fetch(`${API_BASE}/pmo/project?companyId=${COMPANY_ID}&limit=1`);
    const listData = await listRes.json();
    const projectId = listData.data[0]?.id;

    if (!projectId) {
      throw new Error('No project found');
    }

    const res = await fetch(`${API_BASE}/pmo/project/${projectId}`);
    
    expect(res.ok).toBeTruthy();
    const data = await res.json();
    
    expect(data.id).toBe(projectId);
    expect(data.pmoNumber).toMatch(/PM-\d{3}/);
    expect(data.Company).toBeDefined();
  });

  test('AC-004: Project 详情查询（by PMO 号）', async () => {
    const res = await fetch(`${API_BASE}/pmo/project/by-pmo/PM-001?companyId=${COMPANY_ID}`);
    
    expect(res.ok).toBeTruthy();
    const data = await res.json();
    
    expect(data.pmoNumber).toBe('PM-001');
  });

  test('AC-005: Project 状态更新', async () => {
    // 获取 PM-001 项目
    const projectRes = await fetch(`${API_BASE}/pmo/project/by-pmo/PM-001?companyId=${COMPANY_ID}`);
    const project = await projectRes.json();

    // 更新状态为 completed
    const res = await fetch(`${API_BASE}/pmo/project/${project.id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });

    expect(res.ok).toBeTruthy();
    const data = await res.json();
    
    expect(data.status).toBe('completed');
    expect(data.progress).toBe(100);
    expect(data.completedAt).toBeDefined();
  });

  test('AC-006: CEO 指令解析 - 关联已有项目', async () => {
    const res = await fetch(`${API_BASE}/pmo/project/parse-command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: '@PM-001 继续开发' }),
    });

    expect(res.ok).toBeTruthy();
    const data = await res.json();
    
    expect(data.type).toBe('link');
    expect(data.pmoNumber).toBe('PM-001');
  });

  test('AC-007: CEO 指令解析 - 自动创建', async () => {
    const res = await fetch(`${API_BASE}/pmo/project/parse-command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: '实现用户管理功能' }),
    });

    expect(res.ok).toBeTruthy();
    const data = await res.json();
    
    expect(data.type).toBe('auto');
  });

  test('AC-008: CEO 指令解析 - 明确创建', async () => {
    const res = await fetch(`${API_BASE}/pmo/project/parse-command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: '#新项目 实现报表功能' }),
    });

    expect(res.ok).toBeTruthy();
    const data = await res.json();
    
    expect(data.type).toBe('create');
  });
});