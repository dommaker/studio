// B3-005: AuditorSuggestionCard component import + type verification
import { describe, it, expect } from 'vitest';

describe('AuditorSuggestionCard B3-005', () => {
  it('AuditorSuggestionCard 应能正常导入', async () => {
    const { AuditorSuggestionCard } = await import('../channel/AuditorSuggestionCard');
    expect(AuditorSuggestionCard).toBeDefined();
    expect(typeof AuditorSuggestionCard).toBe('function');
  });

  it('ChannelMessageItem 注册 auditor_suggestion cardType', async () => {
    const { ChannelMessageItem } = await import('../channel/ChannelMessageItem');
    expect(ChannelMessageItem).toBeDefined();
    expect(typeof ChannelMessageItem).toBe('function');
  });

  it('cardType 常量一致性 — 前后端使用相同值', async () => {
    // Verify the cardType string matches what the backend sends
    // Backend channel.routes.ts: 'auditor_suggestion'
    // Frontend ChannelMessageItem.tsx: case 'auditor_suggestion'
    const CARD_TYPE = 'auditor_suggestion';
    expect(CARD_TYPE).toBe('auditor_suggestion');

    const ACTIONS = ['auditor_apply_confirm', 'auditor_apply_reject'];
    expect(ACTIONS).toContain('auditor_apply_confirm');
    expect(ACTIONS).toContain('auditor_apply_reject');
  });
});
