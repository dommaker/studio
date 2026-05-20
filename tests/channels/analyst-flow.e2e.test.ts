// B1-001: Analyst /plan + RequirementsDoc Card E2E Test
import { describe, it, expect, beforeAll } from 'vitest';

const API_URL = process.env.API_URL || 'http://localhost:13101/api/v1';
let channelId: string;

describe('B1-001: Channel → @Analyst → RequirementsDoc Card', () => {
  beforeAll(async () => {
    // Fetch or create a channel
    const listRes = await fetch(`${API_URL}/channels`);
    const listData = await listRes.json();
    if (listData.data?.length > 0) {
      channelId = listData.data[0].id;
    } else {
      throw new Error('No channels found. Ensure ensureDefaultChannels() ran.');
    }
  });

  it('list channels returns default channels', async () => {
    const res = await fetch(`${API_URL}/channels`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.length).toBeGreaterThanOrEqual(2);
    expect(data.data.map((c: any) => c.name)).toEqual(
      expect.arrayContaining(['#研发', '#决策', '#系统'])
    );
  });

  it('GET channel messages returns empty list initially', async () => {
    const res = await fetch(`${API_URL}/channels/${channelId}/messages`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(Array.isArray(data.data)).toBe(true);
  });

  it('POST message with <30 chars + @Analyst does NOT trigger', async () => {
    const res = await fetch(`${API_URL}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'short @Analyst' }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.data.analystTriggered).toBe(false);
    expect(data.data.authorType).toBe('human');
  });

  it('POST message with ≥30 chars WITHOUT @Analyst does NOT trigger', async () => {
    const res = await fetch(`${API_URL}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '这是一个足够长的消息用于测试触发逻辑但不包含关键词'.repeat(1) }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.data.analystTriggered).toBe(false);
  });

  it('POST message with ≥30 chars + @Analyst triggers analysis', async () => {
    const res = await fetch(`${API_URL}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '我们需要实现一个基于JWT的用户认证系统，支持token刷新和OAuth2.0第三方登录 @Analyst',
      }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.data.analystTriggered).toBe(true);
    expect(data.data.authorType).toBe('human');
  });

  it('eventually receives a RequirementsDoc card from Analyst', async () => {
    // Poll for up to 30s waiting for the analyst response
    let foundCard = false;
    for (let i = 0; i < 15; i++) {
      const res = await fetch(`${API_URL}/channels/${channelId}/messages`);
      const data = await res.json();
      const analystMessages = data.data.filter(
        (m: any) => m.authorType === 'agent' && m.agentName === 'Analyst'
      );
      for (const msg of analystMessages) {
        try {
          const meta = JSON.parse(msg.meta || '{}');
          if (meta.cardType === 'requirements_doc') {
            foundCard = true;
            expect(meta.status).toBe('ready');
            expect(meta.requirementsDocId).toBeDefined();
            expect(msg.content).toContain('📋');
            break;
          }
        } catch {}
      }
      if (foundCard) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    expect(foundCard).toBe(true);
  }, 35000);
});
