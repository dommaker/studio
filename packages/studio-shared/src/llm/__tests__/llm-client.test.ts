// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { llmClient, LLMClient } from '../llm-client';
import type { LLMConfig, ChatMessage } from '../llm-client';

describe('LLMClient', () => {
  it('should export llmClient instance', () => {
    expect(llmClient).toBeDefined();
    expect(llmClient).toBeInstanceOf(LLMClient);
  });

  it('should export LLMConfig type', () => {
    const config: LLMConfig = {
      provider: 'tencent',
      apiKey: 'test',
      baseUrl: 'https://test',
      model: 'test-model',
    };
    expect(config.provider).toBe('tencent');
  });

  it('should export ChatMessage type', () => {
    const message: ChatMessage = {
      role: 'user',
      content: 'test',
    };
    expect(message.role).toBe('user');
  });

  it('should have chat method', () => {
    expect(llmClient.chat).toBeDefined();
    expect(typeof llmClient.chat).toBe('function');
  });

  it('should have chatCompletion method', () => {
    expect(llmClient.chatCompletion).toBeDefined();
    expect(typeof llmClient.chatCompletion).toBe('function');
  });

  it('should have chatJson method', () => {
    expect(llmClient.chatJson).toBeDefined();
    expect(typeof llmClient.chatJson).toBe('function');
  });
});