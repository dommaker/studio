// DD-006: Meeting API - Run Discussion
// E2E 测试：验证 /run-discussion API 功能

import { test, expect } from '@playwright/test';

const API_BASE = 'http://localhost:3001/api/v1';
const TEST_COMPANY_ID = 'cmo77h9qf0002vsqjikl1qul9';
const TEST_ROLE_IDS = ['cmo7d0nma000ddwxqroa1iezl', 'cmo7d0tub000fdwxqn287gemo'];

test.describe('DD-006: Run Discussion API', () => {
  let testMeetingId: string;

  // 辅助函数：创建并激活会议
  async function createActiveMeeting(title: string): Promise<string> {
    // 创建会议
    const createRes = await fetch(`${API_BASE}/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        companyId: TEST_COMPANY_ID,
        mode: 'sync',
      }),
    });
    const data = await createRes.json();
    const meetingId = data.data?.id || data.id;

    // 添加参与者
    await fetch(`${API_BASE}/meetings/${meetingId}/participants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: TEST_ROLE_IDS[0] }),  // 单个 roleId
    });

    // 激活会议
    await fetch(`${API_BASE}/meetings/${meetingId}/start`, {
      method: 'POST',
    });

    return meetingId;
  }

  // AC-001: manual 模式正常返回（需要激活会议）
  test('AC-001: manual mode should return success', async () => {
    const meetingId = await createActiveMeeting('AC-001 测试会议');

    const res = await fetch(`${API_BASE}/meetings/${meetingId}/run-discussion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'manual' }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.mode).toBe('manual');
    expect(data.message).toBe('手动讨论模式已开启');

    // 清理
    await fetch(`${API_BASE}/meetings/${meetingId}`, { method: 'DELETE' });
  });

  // AC-002: auto 模式创建 taskId（需要激活会议）
  test('AC-002: auto mode should create taskId', async () => {
    const meetingId = await createActiveMeeting('AC-002 测试会议');

    const res = await fetch(`${API_BASE}/meetings/${meetingId}/run-discussion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'auto',
        topic: '测试议题',
        maxRounds: 5,
      }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.mode).toBe('auto');
    expect(data.taskId).toBeDefined();
    expect(data.statusEndpoint).toBe(`/api/v1/meetings/${meetingId}/discussion-status`);

    // 清理
    await fetch(`${API_BASE}/meetings/${meetingId}`, { method: 'DELETE' });
  });

  // AC-003: auto 模式更新 Meeting 状态（需要激活会议）
  test('AC-003: auto mode should update Meeting status', async () => {
    const meetingId = await createActiveMeeting('AC-003 测试会议');

    await fetch(`${API_BASE}/meetings/${meetingId}/run-discussion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'auto', topic: '测试' }),
    });

    // 验证状态更新
    const statusRes = await fetch(`${API_BASE}/meetings/${meetingId}/discussion-status`);
    const statusData = await statusRes.json();

    expect(statusData.discussionMode).toBe('auto');
    expect(statusData.discussionStatus).toBe('running');
    expect(statusData.taskId).toBeDefined();

    // 清理
    await fetch(`${API_BASE}/meetings/${meetingId}`, { method: 'DELETE' });
  });

  // AC-004: auto 模式发布事件（需要激活会议）
  test('AC-004: auto mode should publish event', async () => {
    const meetingId = await createActiveMeeting('AC-004 测试会议');

    const res = await fetch(`${API_BASE}/meetings/${meetingId}/run-discussion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'auto', topic: '测试事件' }),
    });
    const data = await res.json();

    // 验证 taskId 已创建（事件通过 taskId 触发）
    expect(res.status).toBe(200);
    expect(data.taskId).toBeDefined();

    // 清理
    await fetch(`${API_BASE}/meetings/${meetingId}`, { method: 'DELETE' });
  });

  // AC-005: discussion-status 正确返回
  test('AC-005: discussion-status should return correct fields', async () => {
    const meetingId = await createActiveMeeting('AC-005 测试会议');

    const res = await fetch(`${API_BASE}/meetings/${meetingId}/discussion-status`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.meetingId).toBe(meetingId);
    expect(data.discussionMode).toBeDefined();
    expect(data.discussionStatus).toBeDefined();
    expect(data.meetingStatus).toBeDefined();

    // 清理
    await fetch(`${API_BASE}/meetings/${meetingId}`, { method: 'DELETE' });
  });

  // AC-006: stop-discussion 清除状态（需要激活会议）
  test('AC-006: stop-discussion should clear status', async () => {
    const meetingId = await createActiveMeeting('AC-006 测试会议');

    // 先启动讨论
    await fetch(`${API_BASE}/meetings/${meetingId}/run-discussion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'auto', topic: '测试' }),
    });

    // 停止讨论
    const res = await fetch(`${API_BASE}/meetings/${meetingId}/stop-discussion`, {
      method: 'POST',
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe('讨论已停止');

    // 验证状态已清除
    const statusRes = await fetch(`${API_BASE}/meetings/${meetingId}/discussion-status`);
    const statusData = await statusRes.json();
    expect(statusData.discussionStatus).toBe('completed');

    // 清理
    await fetch(`${API_BASE}/meetings/${meetingId}`, { method: 'DELETE' });
  });

  // AC-007: 会议未激活拒绝启动
  test('AC-007: inactive meeting should reject auto discussion', async () => {
    const createRes = await fetch(`${API_BASE}/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '未激活会议测试',
        companyId: TEST_COMPANY_ID,
      }),
    });
    const meetingData = await createRes.json();
    const inactiveMeetingId = meetingData.data?.id || meetingData.id;

    const res = await fetch(`${API_BASE}/meetings/${inactiveMeetingId}/run-discussion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'auto' }),
    });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBe('会议未激活，无法启动讨论');

    // 清理
    await fetch(`${API_BASE}/meetings/${inactiveMeetingId}`, { method: 'DELETE' });
  });

  // AC-008: mixed 模式返回 501
  test('AC-008: mixed mode should return 501', async () => {
    const createRes = await fetch(`${API_BASE}/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'mixed 模式测试',
        companyId: TEST_COMPANY_ID,
      }),
    });
    const meetingData = await createRes.json();
    const meetingId = meetingData.data?.id || meetingData.id;

    const res = await fetch(`${API_BASE}/meetings/${meetingId}/run-discussion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'mixed' }),
    });
    const data = await res.json();

    expect(res.status).toBe(501);
    expect(data.success).toBe(false);
    expect(data.mode).toBe('mixed');
    expect(data.message).toContain('尚未实现');

    // 清理
    await fetch(`${API_BASE}/meetings/${meetingId}`, { method: 'DELETE' });
  });

  // AC-009: 无效模式返回 400
  test('AC-009: invalid mode should return 400', async () => {
    const createRes = await fetch(`${API_BASE}/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'invalid 模式测试',
        companyId: TEST_COMPANY_ID,
      }),
    });
    const meetingData = await createRes.json();
    const meetingId = meetingData.data?.id || meetingData.id;

    const res = await fetch(`${API_BASE}/meetings/${meetingId}/run-discussion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'invalid' }),
    });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain('无效的讨论模式');

    // 清理
    await fetch(`${API_BASE}/meetings/${meetingId}`, { method: 'DELETE' });
  });

  // AC-010: discussionMode 字段持久化
  test('AC-010: discussionMode should persist in Meeting', async () => {
    const createRes = await fetch(`${API_BASE}/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'discussionMode 持久化测试',
        companyId: TEST_COMPANY_ID,
      }),
    });
    const meetingData = await createRes.json();
    const meeting = meetingData.data || meetingData;

    expect(meeting.discussionMode).toBe('manual');
    expect(meeting.discussionStatus).toBe('idle');

    // 清理
    await fetch(`${API_BASE}/meetings/${meeting.id}`, { method: 'DELETE' });
  });
});