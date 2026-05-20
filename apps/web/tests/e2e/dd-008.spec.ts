// DD-008: DiscussionDriver 集成测试
// E2E 测试：验证 DiscussionDriver 自动讨论功能

import { test, expect } from '@playwright/test';

const API_BASE = 'http://localhost:3001/api/v1';
const TEST_COMPANY_ID = 'cmo77h9qf0002vsqjikl1qul9';
const TEST_ROLE_IDS = ['cmo7d0nma000ddwxqroa1iezl', 'cmo7d0tub000fdwxqn287gemo'];

test.describe('DD-008: DiscussionDriver Integration', () => {
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
      body: JSON.stringify({ roleId: TEST_ROLE_IDS[0] }),
    });

    await fetch(`${API_BASE}/meetings/${meetingId}/participants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: TEST_ROLE_IDS[1] }),
    });

    // 激活会议
    await fetch(`${API_BASE}/meetings/${meetingId}/start`, {
      method: 'POST',
    });

    return meetingId;
  }

  // AC-001: DiscussionDriver 启动成功
  test('AC-001: DiscussionDriver should start successfully', async () => {
    testMeetingId = await createActiveMeeting('AC-001 DiscussionDriver 测试');

    const res = await fetch(`${API_BASE}/meetings/${testMeetingId}/run-discussion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'auto',
        topic: '测试议题：讨论是否需要添加新功能',
        maxRounds: 3, // 限制轮数以加快测试
      }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.mode).toBe('auto');
    expect(data.taskId).toBeDefined();

    // 清理
    await fetch(`${API_BASE}/meetings/${testMeetingId}`, { method: 'DELETE' });
  });

  // AC-002: DiscussionDriver 发送消息到 Meeting
  test('AC-002: DiscussionDriver should send messages', async () => {
    testMeetingId = await createActiveMeeting('AC-002 发送消息测试');

    // 启动讨论
    await fetch(`${API_BASE}/meetings/${testMeetingId}/run-discussion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'auto',
        topic: '测试议题',
        maxRounds: 2,
      }),
    });

    // 等待讨论完成（最多 30 秒）
    await new Promise(resolve => setTimeout(resolve, 30000));

    // 检查消息是否发送
    const messagesRes = await fetch(`${API_BASE}/meetings/${testMeetingId}/messages`);
    const messagesData = await messagesRes.json();

    expect(messagesRes.status).toBe(200);
    expect(messagesData.data.length).toBeGreaterThanOrEqual(1);

    // 清理
    await fetch(`${API_BASE}/meetings/${testMeetingId}`, { method: 'DELETE' });
  });

  // AC-003: discussion-status 正确反映讨论状态
  test('AC-003: discussion-status should reflect discussion state', async () => {
    testMeetingId = await createActiveMeeting('AC-003 状态测试');

    // 启动讨论
    await fetch(`${API_BASE}/meetings/${testMeetingId}/run-discussion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'auto',
        topic: '测试议题',
        maxRounds: 2,
      }),
    });

    // 等待一会
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 检查状态
    const statusRes = await fetch(`${API_BASE}/meetings/${testMeetingId}/discussion-status`);
    const statusData = await statusRes.json();

    expect(statusRes.status).toBe(200);
    expect(statusData.discussionMode).toBe('auto');
    expect(['running', 'completed']).toContain(statusData.discussionStatus);

    // 清理
    await fetch(`${API_BASE}/meetings/${testMeetingId}`, { method: 'DELETE' });
  });

  // AC-004: 讨论完成后更新会议 summary
  test('AC-004: Meeting summary should be updated after discussion', async () => {
    testMeetingId = await createActiveMeeting('AC-004 Summary 测试');

    // 启动讨论
    await fetch(`${API_BASE}/meetings/${testMeetingId}/run-discussion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'auto',
        topic: '测试议题',
        maxRounds: 2,
      }),
    });

    // 等待讨论完成
    await new Promise(resolve => setTimeout(resolve, 30000));

    // 检查会议 summary
    const meetingRes = await fetch(`${API_BASE}/meetings/${testMeetingId}`);
    const meetingData = await meetingRes.json();

    expect(meetingRes.status).toBe(200);
    expect(meetingData.data.summary).toBeDefined();
    expect(meetingData.data.discussionStatus).toBe('completed');

    // 清理
    await fetch(`${API_BASE}/meetings/${testMeetingId}`, { method: 'DELETE' });
  });

  // AC-005: 停止讨论正常工作
  test('AC-005: stop-discussion should work correctly', async () => {
    testMeetingId = await createActiveMeeting('AC-005 Stop 测试');

    // 启动讨论
    await fetch(`${API_BASE}/meetings/${testMeetingId}/run-discussion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'auto',
        topic: '测试议题',
        maxRounds: 10,
      }),
    });

    // 立即停止
    const stopRes = await fetch(`${API_BASE}/meetings/${testMeetingId}/stop-discussion`, {
      method: 'POST',
    });
    const stopData = await stopRes.json();

    expect(stopRes.status).toBe(200);
    expect(stopData.success).toBe(true);

    // 验证状态已停止
    const statusRes = await fetch(`${API_BASE}/meetings/${testMeetingId}/discussion-status`);
    const statusData = await statusRes.json();
    expect(statusData.discussionStatus).toBe('completed');

    // 清理
    await fetch(`${API_BASE}/meetings/${testMeetingId}`, { method: 'DELETE' });
  });
});