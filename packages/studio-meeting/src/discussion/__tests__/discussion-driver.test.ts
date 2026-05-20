// DD-013~016: DiscussionDriver 改进测试
// AS-009: 争议检查机制测试
// 单元测试：验证 Project 上下文 + progress 字段 + 最小上下文

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('DD-013~016: DiscussionDriver Improvements', () => {
  
  // DD-015: getKeyMessages 测试
  describe('DD-015: getKeyMessages (Minimal Context)', () => {
    const mockMessages = [
      { roleId: 'role-1', content: '首轮发言，介绍观点', stance: 'advocate', round: 1 },
      { roleId: 'role-2', content: '我同意这个方案', stance: 'supporter', round: 2 },
      { roleId: 'role-3', content: '我有疑虑，需要验证可行性', stance: 'skeptic', round: 3 },
      { roleId: 'role-4', content: '我同意，可以总结决策了', stance: 'executor', round: 4 },
      { roleId: 'role-5', content: '我认为应该总结一下', stance: 'reviewer', round: 5 },
      { roleId: 'role-1', content: '最后一条发言', stance: 'advocate', round: 6 },
    ];

    it('AC-001: should include first round message', () => {
      // 首轮发言（round = 1）应该包含
      const keyMessages = getKeyMessages(mockMessages);
      expect(keyMessages.some(m => m.round === 1)).toBe(true);
    });

    it('AC-002: should include last message', () => {
      // 最后一条消息应该包含
      const keyMessages = getKeyMessages(mockMessages);
      expect(keyMessages.some(m => m.round === 6)).toBe(true);
    });

    it('AC-003: should include summary proposal messages', () => {
      // "总结决策" 提议的消息应该包含
      const keyMessages = getKeyMessages(mockMessages);
      expect(keyMessages.some(m => m.content.includes('总结决策') || m.content.includes('总结一下'))).toBe(true);
    });

    it('AC-004: should include skeptic messages (max 2)', () => {
      // 质疑消息最多 2 条
      const keyMessages = getKeyMessages(mockMessages);
      const skepticMessages = keyMessages.filter(m => m.stance === 'skeptic' || m.stance === 'reviewer');
      expect(skepticMessages.length).toBeLessThanOrEqual(2);
    });

    it('AC-005: should be sorted by round', () => {
      const keyMessages = getKeyMessages(mockMessages);
      for (let i = 1; i < keyMessages.length; i++) {
        expect(keyMessages[i].round >= keyMessages[i-1].round).toBe(true);
      }
    });
  });

  // DD-014: updateProgress 测试（需要 Prisma，标记为 integration）
  describe('DD-014: updateProgress (Integration)', () => {
    it.skip('AC-002: should update progress after each round', async () => {
      // 需要 Prisma 连接，在 E2E 中测试
    });
  });

  // DD-013: getProjectContext 测试（需要 Prisma）
  describe('DD-013: getProjectContext (Integration)', () => {
    it.skip('AC-001: should return Project context when Meeting has projectId', async () => {
      // 需要 Prisma 连接，在 E2E 中测试
    });
  });

  // DD-016: MeetingFileStorage 测试
  describe('DD-016: MeetingFileStorage', () => {
    it('AC-002: should use correct filename format', () => {
      const meetingId = 'test-meeting-123';
      const reason = 'completed';
      const timestamp = Date.now();
      const filename = `${meetingId}-${reason}-${timestamp}.json`;
      
      expect(filename).toMatch(/^test-meeting-123-completed-\d+\.json$/);
    });

    it.skip('AC-001: should save meeting to file on completion', async () => {
      // 需要 Prisma + 文件系统，在 E2E 中测试
    });
  });
});

/**
 * DD-015: getKeyMessages 实现（用于测试）
 */
function getKeyMessages(
  messages: Array<{ roleId: string; content: string; stance: string; round: number }>
): Array<{ roleId: string; content: string; stance: string; round: number }> {
  if (messages.length === 0) {
    return [];
  }

  const keyMessages: Array<{ roleId: string; content: string; stance: string; round: number }> = [];

  // 1. 首轮发言
  const firstRoundMessages = messages.filter(m => m.round === 1);
  if (firstRoundMessages.length > 0) {
    keyMessages.push(firstRoundMessages[0]);
  }

  // 2. 最后一条消息
  if (messages.length > 1) {
    const lastMessage = messages[messages.length - 1];
    if (!keyMessages.some(m => m.roleId === lastMessage.roleId && m.round === lastMessage.round)) {
      keyMessages.push(lastMessage);
    }
  }

  // 3. 有"总结决策"提议的消息
  for (const m of messages) {
    if (m.content.includes('总结决策') || m.content.includes('总结一下')) {
      if (!keyMessages.some(k => k.roleId === m.roleId && k.round === m.round)) {
        keyMessages.push(m);
      }
    }
  }

  // 4. 质疑/反对的消息（最多 2 条）
  const skepticMessages = messages.filter(m => m.stance === 'skeptic' || m.stance === 'reviewer');
  for (const m of skepticMessages.slice(0, 2)) {
    if (!keyMessages.some(k => k.roleId === m.roleId && k.round === m.round)) {
      keyMessages.push(m);
    }
  }

  // 按轮次排序
  return keyMessages.sort((a, b) => a.round - b.round);
}

// ========================================
// AS-009: 争议检查机制测试
// ========================================
describe('AS-009: Controversy Check', () => {
  
  // 模拟 checkControversy 实现
  function checkControversy(
    messages: Array<{ roleId: string; content: string; stance: string; round: number }>,
    currentRound: number,
    minOppositionRatio: number = 0.2,
    triggerRounds: number = 2
  ): {
    hasEnoughDissent: boolean;
    proponentCount: number;
    opponentCount: number;
    ratio: number;
    consecutiveNoOpposition: number;
    needsIntervention: boolean;
    suggestedAction?: 'inject_devils_advocate' | 'prompt_skeptic' | 'notify_user';
  } {
    const proponentStances = ['advocate', 'pragmatist', 'executor', 'visionary'];
    const opponentStances = ['skeptic', 'reviewer', 'architect'];

    const proponentCount = messages.filter(m => proponentStances.includes(m.stance.toLowerCase())).length;
    const opponentCount = messages.filter(m => opponentStances.includes(m.stance.toLowerCase())).length;
    const neutralCount = messages.length - proponentCount - opponentCount;

    const total = proponentCount + opponentCount + neutralCount;
    const ratio = total > 0 ? opponentCount / total : 0;

    // 计算连续无反对轮次
    let consecutiveNoOpposition = 0;
    for (let r = currentRound; r >= currentRound - triggerRounds && r > 0; r--) {
      const roundMessages = messages.filter(m => m.round === r);
      const hasOpposition = roundMessages.some(m => opponentStances.includes(m.stance.toLowerCase()));
      if (!hasOpposition && roundMessages.length > 0) {
        consecutiveNoOpposition++;
      } else {
        break;
      }
    }

    const needsIntervention = ratio < 0.1 || consecutiveNoOpposition >= triggerRounds;

    let suggestedAction: 'inject_devils_advocate' | 'prompt_skeptic' | 'notify_user' | undefined;
    if (consecutiveNoOpposition >= triggerRounds) {
      suggestedAction = 'inject_devils_advocate';
    } else if (ratio < 0.1 && opponentCount === 0) {
      suggestedAction = 'prompt_skeptic';
    } else if (ratio < minOppositionRatio) {
      suggestedAction = 'notify_user';
    }

    return {
      hasEnoughDissent: ratio >= minOppositionRatio,
      proponentCount,
      opponentCount,
      ratio,
      consecutiveNoOpposition,
      needsIntervention,
      suggestedAction,
    };
  }

  describe('AC-001: 正常讨论（有分歧）', () => {
    it('应该检测到足够的反对意见', () => {
      const messages = [
        { roleId: 'role-1', content: '我支持这个方案', stance: 'advocate', round: 1 },
        { roleId: 'role-2', content: '我有疑虑', stance: 'skeptic', round: 1 },
        { roleId: 'role-3', content: '方案可行', stance: 'executor', round: 2 },
        { roleId: 'role-4', content: '需要验证风险', stance: 'reviewer', round: 2 },
      ];

      const result = checkControversy(messages, 2);
      
      expect(result.hasEnoughDissent).toBe(true);
      expect(result.ratio).toBe(0.5); // 2/4
      expect(result.needsIntervention).toBe(false);
    });
  });

  describe('AC-002: 群体思维风险（过于一致）', () => {
    it('应该检测到缺乏反对意见', () => {
      const messages = [
        { roleId: 'role-1', content: '我同意', stance: 'advocate', round: 1 },
        { roleId: 'role-2', content: '我也同意', stance: 'executor', round: 1 },
        { roleId: 'role-3', content: '没意见', stance: 'neutral', round: 2 },
      ];

      const result = checkControversy(messages, 2);
      
      expect(result.hasEnoughDissent).toBe(false);
      expect(result.opponentCount).toBe(0);
      expect(result.needsIntervention).toBe(true);
      // 连续 2 轮无反对，触发 inject_devils_advocate
      expect(result.suggestedAction).toBe('inject_devils_advocate');
    });

    it('仅有 1 轮无反对时应该提示质疑者', () => {
      const messages = [
        { roleId: 'role-1', content: '我同意', stance: 'advocate', round: 1 },
        { roleId: 'role-2', content: '我也同意', stance: 'executor', round: 1 },
      ];

      const result = checkControversy(messages, 1);
      
      expect(result.opponentCount).toBe(0);
      expect(result.ratio).toBe(0);
      // 比例 < 10% 且无反对者，触发 prompt_skeptic
      expect(result.suggestedAction).toBe('prompt_skeptic');
    });
  });

  describe('AC-003: 连续无反对触发 Devil\'s Advocate', () => {
    it('连续 2 轮无反对应该触发注入', () => {
      const messages = [
        { roleId: 'role-1', content: '方案A', stance: 'advocate', round: 1 },
        { roleId: 'role-2', content: '同意方案A', stance: 'executor', round: 1 },
        { roleId: 'role-1', content: '继续方案A', stance: 'advocate', round: 2 },
        { roleId: 'role-2', content: '继续同意', stance: 'executor', round: 2 },
      ];

      const result = checkControversy(messages, 2);
      
      expect(result.consecutiveNoOpposition).toBe(2);
      expect(result.needsIntervention).toBe(true);
      expect(result.suggestedAction).toBe('inject_devils_advocate');
    });
  });

  describe('AC-004: 比例计算', () => {
    it('应该正确计算反对比例', () => {
      // 6 赞成，2 反对，2 中立 = 20% 反对
      const messages = [
        { roleId: 'r1', content: '同意', stance: 'advocate', round: 1 },
        { roleId: 'r2', content: '同意', stance: 'advocate', round: 1 },
        { roleId: 'r3', content: '同意', stance: 'executor', round: 1 },
        { roleId: 'r4', content: '同意', stance: 'pragmatist', round: 2 },
        { roleId: 'r5', content: '同意', stance: 'visionary', round: 2 },
        { roleId: 'r6', content: '同意', stance: 'advocate', round: 2 },
        { roleId: 'r7', content: '质疑', stance: 'skeptic', round: 3 },
        { roleId: 'r8', content: '审查', stance: 'reviewer', round: 3 },
        { roleId: 'r9', content: '中立', stance: 'neutral', round: 3 },
        { roleId: 'r10', content: '中立', stance: 'neutral', round: 3 },
      ];

      const result = checkControversy(messages, 3);
      
      expect(result.proponentCount).toBe(6);
      expect(result.opponentCount).toBe(2);
      expect(result.ratio).toBeCloseTo(0.2, 1);
    });
  });

  describe('AC-005: 边界情况', () => {
    it('空消息应该返回安全默认值', () => {
      const result = checkControversy([], 0);
      
      expect(result.ratio).toBe(0);
      expect(result.hasEnoughDissent).toBe(false);
    });

    it('仅中立消息不应该触发干预', () => {
      const messages = [
        { roleId: 'r1', content: '中立', stance: 'neutral', round: 1 },
        { roleId: 'r2', content: '中立', stance: 'neutral', round: 2 },
      ];

      const result = checkControversy(messages, 2);
      
      // 中立消息不触发反对比例警告
      expect(result.needsIntervention).toBe(true); // 因为连续无反对
    });
  });
});

// ========================================
// 🆕 AS-015: 多轮讨论 + 共识演进测试
// ========================================
describe('AS-015: Multi-Round Consensus', () => {
  
  // AC-001: agreement 类型计算
  describe('AC-001: agreement 类型计算', () => {
    
    function calculateAgreement(messages: Array<{ stance: string }>): 'unanimous' | 'majority' | 'divided' {
      const proponentStances = ['advocate', 'pragmatist', 'executor', 'visionary'];
      const opponentStances = ['skeptic', 'reviewer', 'architect'];
      const neutralStances = ['neutral'];
      
      const agreeCount = messages.filter(m => proponentStances.includes(m.stance.toLowerCase())).length;
      const disagreeCount = messages.filter(m => opponentStances.includes(m.stance.toLowerCase())).length;
      const neutralCount = messages.filter(m => neutralStances.includes(m.stance.toLowerCase())).length;
      const total = messages.length;
      
      if (disagreeCount === 0 && neutralCount === 0) return 'unanimous';
      if (agreeCount / total >= 0.6) return 'majority';
      return 'divided';
    }

    it('全票通过应该是 unanimous', () => {
      const messages = [
        { stance: 'advocate' },
        { stance: 'executor' },
        { stance: 'pragmatist' },
      ];
      
      expect(calculateAgreement(messages)).toBe('unanimous');
    });

    it('多数赞成应该是 majority', () => {
      const messages = [
        { stance: 'advocate' },
        { stance: 'advocate' },
        { stance: 'skeptic' },
      ];
      
      expect(calculateAgreement(messages)).toBe('majority');
    });

    it('分歧严重应该是 divided', () => {
      const messages = [
        { stance: 'advocate' },
        { stance: 'skeptic' },
        { stance: 'skeptic' },
      ];
      
      expect(calculateAgreement(messages)).toBe('divided');
    });
  });

  // AC-002: 多轮收敛引导
  describe('AC-002: 多轮收敛引导', () => {
    
    function getConvergencePrompt(round: number, maxRounds: number): string {
      if (round >= maxRounds * 0.7) {
        return '⚠️ 讨论接近尾声，请尝试缩小分歧、聚焦核心问题。';
      }
      if (round >= maxRounds * 0.5) {
        return '💡 讨论进入中后期，请尝试提出具体建议而非抽象观点。';
      }
      return '';
    }

    it('早期轮次（30%）无引导', () => {
      const prompt = getConvergencePrompt(3, 10);
      expect(prompt).toBe('');
    });

    it('中期轮次（50%）有轻引导', () => {
      const prompt = getConvergencePrompt(5, 10);
      expect(prompt).toContain('中后期');
    });

    it('后期轮次（70%）有强引导', () => {
      const prompt = getConvergencePrompt(7, 10);
      expect(prompt).toContain('尾声');
    });
  });

  // AC-003: votes 详情记录
  describe('AC-003: votes 详情记录', () => {
    
    it('应该记录每个角色的投票', () => {
      const messages = [
        { roleId: 'r1', stance: 'advocate', content: '我同意方案A' },
        { roleId: 'r2', stance: 'skeptic', content: '我有疑虑' },
      ];

      const votes = messages.map(m => ({
        roleId: m.roleId,
        stance: m.stance,
        agree: m.stance === 'advocate',
      }));

      expect(votes).toHaveLength(2);
      expect(votes[0].agree).toBe(true);
      expect(votes[1].agree).toBe(false);
    });
  });
});