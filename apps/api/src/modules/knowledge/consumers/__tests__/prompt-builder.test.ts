/**
 * buildKnowledgeContext — unified knowledge injection tests
 * Phase 1: wraps existing functions (formatCompactForPrompt + formatIndexSummary)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock knowledgeQuery
const mockFormatCompactForPrompt = vi.fn();
const mockFormatAllForPrompt = vi.fn();
vi.mock('../../knowledge-query.service.js', () => ({
  knowledgeQuery: {
    formatCompactForPrompt: mockFormatCompactForPrompt,
    formatAllForPrompt: mockFormatAllForPrompt,
  },
}));

// Mock knowledgeBus
const mockFormatIndexSummary = vi.fn();
vi.mock('../../knowledge-bus.service.js', () => ({
  knowledgeBus: {
    formatIndexSummary: mockFormatIndexSummary,
  },
}));

// Import after mocks
const { buildKnowledgeContext } = await import('../prompt-builder.js');

describe('buildKnowledgeContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('default (compact) mode', () => {
    it('should call formatCompactForPrompt with agentType', async () => {
      mockFormatCompactForPrompt.mockResolvedValue('## rules\n- rule1');
      mockFormatIndexSummary.mockReturnValue('[index: 10 items]');

      await buildKnowledgeContext('executor');

      expect(mockFormatCompactForPrompt).toHaveBeenCalledWith('executor');
      expect(mockFormatAllForPrompt).not.toHaveBeenCalled();
    });

    it('should call formatIndexSummary', async () => {
      mockFormatCompactForPrompt.mockResolvedValue('');
      mockFormatIndexSummary.mockReturnValue('[index: 10 items]');

      await buildKnowledgeContext('executor');

      expect(mockFormatIndexSummary).toHaveBeenCalled();
    });

    it('should combine compact + index output', async () => {
      mockFormatCompactForPrompt.mockResolvedValue('## rules\n- no redis');
      mockFormatIndexSummary.mockReturnValue('[knowledge: 5 items]');

      const result = await buildKnowledgeContext('executor');

      expect(result).toContain('## rules\n- no redis');
      expect(result).toContain('[knowledge: 5 items]');
    });

    it('should handle empty compact output', async () => {
      mockFormatCompactForPrompt.mockResolvedValue('');
      mockFormatIndexSummary.mockReturnValue('[knowledge: 0 items]');

      const result = await buildKnowledgeContext('executor');

      expect(result).toContain('[knowledge: 0 items]');
    });

    it('should pass different agentTypes correctly', async () => {
      mockFormatCompactForPrompt.mockResolvedValue('');
      mockFormatIndexSummary.mockReturnValue('');

      await buildKnowledgeContext('analyst');
      expect(mockFormatCompactForPrompt).toHaveBeenCalledWith('analyst');

      await buildKnowledgeContext('reviewer');
      expect(mockFormatCompactForPrompt).toHaveBeenCalledWith('reviewer');
    });
  });

  describe('full mode', () => {
    it('should call formatAllForPrompt when mode is full', async () => {
      mockFormatAllForPrompt.mockResolvedValue('## all knowledge');
      mockFormatIndexSummary.mockReturnValue('[index]');

      const result = await buildKnowledgeContext('analyst', { mode: 'full' });

      expect(mockFormatAllForPrompt).toHaveBeenCalledWith('analyst');
      expect(mockFormatCompactForPrompt).not.toHaveBeenCalled();
      expect(result).toContain('## all knowledge');
      expect(result).toContain('[index]');
    });
  });
});
