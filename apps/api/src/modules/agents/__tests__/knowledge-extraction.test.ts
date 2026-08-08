/**
 * knowledge-extraction — 提取 prompt 单一来源单元测试
 *
 * 自足测试（不依赖真实 LLM）：
 * - readPromptOverride mock：控制 E1 文件覆盖命中/未命中
 *
 * 覆盖：
 *  - getExtractFromTextSystemPrompt：E1 override 命中/未命中
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockReadPromptOverride } = vi.hoisted(() => ({
  mockReadPromptOverride: vi.fn(() => null),
}));

vi.mock('@dommaker/studio-shared', () => ({
  readPromptOverride: mockReadPromptOverride,
}));

import {
  getExtractFromTextSystemPrompt,
  EXTRACT_FROM_TEXT_SYSTEM_PROMPT,
} from '../knowledge/knowledge-extraction.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockReadPromptOverride.mockReturnValue(null);
});

describe('getExtractFromTextSystemPrompt (E1)', () => {
  it('无 override 时返回默认常量', () => {
    expect(getExtractFromTextSystemPrompt()).toBe(EXTRACT_FROM_TEXT_SYSTEM_PROMPT);
    expect(mockReadPromptOverride).toHaveBeenCalledWith('knowledge.extract-from-text');
  });

  it('override 命中时返回覆盖内容', () => {
    mockReadPromptOverride.mockReturnValue('custom-prompt');
    expect(getExtractFromTextSystemPrompt()).toBe('custom-prompt');
  });
});
