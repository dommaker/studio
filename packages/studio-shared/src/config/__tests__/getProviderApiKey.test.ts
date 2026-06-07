import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { getProviderApiKey, getConfigSummary } from '../index';
import type { WorkloadType } from '../index';

describe('getProviderApiKey', () => {
  const savedEnv: Record<string, string | undefined> = {};

  const envKeys = [
    'CONVERSATION_API_KEY', 'PIPELINE_API_KEY', 'STUDIO_API_KEY',
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY_1', 'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'LLM_API_KEY', 'CODING_API_KEY_1',
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  describe('base behavior (no workload)', () => {
    test('returns ANTHROPIC_API_KEY for anthropic provider', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key-1234';
      expect(getProviderApiKey('anthropic')).toBe('test-key-1234');
    });

    test('returns DEEPSEEK_API_KEY for deepseek provider', () => {
      process.env.DEEPSEEK_API_KEY = 'ds-key';
      expect(getProviderApiKey('deepseek')).toBe('ds-key');
    });

    test('returns undefined when no key is set', () => {
      expect(getProviderApiKey('anthropic')).toBeUndefined();
    });

    test('ANTHROPIC_AUTH_TOKEN takes priority over ANTHROPIC_API_KEY', () => {
      process.env.ANTHROPIC_AUTH_TOKEN = 'auth-token';
      process.env.ANTHROPIC_API_KEY = 'api-key';
      expect(getProviderApiKey('anthropic')).toBe('auth-token');
    });

    test('STUDIO_API_KEY is used as fallback for anthropic provider', () => {
      process.env.STUDIO_API_KEY = 'fallback';
      expect(getProviderApiKey('anthropic')).toBe('fallback');
    });
  });

  describe('workload=conversation', () => {
    test('returns CONVERSATION_API_KEY when set', () => {
      process.env.CONVERSATION_API_KEY = 'conv-key-xyz';
      process.env.ANTHROPIC_API_KEY = 'base-key';
      expect(getProviderApiKey('anthropic', 'conversation')).toBe('conv-key-xyz');
    });

    test('falls back to base key when CONVERSATION_API_KEY is not set', () => {
      process.env.ANTHROPIC_API_KEY = 'base-key';
      expect(getProviderApiKey('anthropic', 'conversation')).toBe('base-key');
    });

    test('returns undefined when neither workload nor base key is set', () => {
      expect(getProviderApiKey('anthropic', 'conversation')).toBeUndefined();
    });

    test('CONVERSATION_API_KEY works for any provider', () => {
      process.env.CONVERSATION_API_KEY = 'conv-key';
      expect(getProviderApiKey('openai', 'conversation')).toBe('conv-key');
    });
  });

  describe('workload=pipeline', () => {
    test('returns PIPELINE_API_KEY when set', () => {
      process.env.PIPELINE_API_KEY = 'pipe-key-abc';
      process.env.ANTHROPIC_API_KEY = 'base-key';
      expect(getProviderApiKey('anthropic', 'pipeline')).toBe('pipe-key-abc');
    });

    test('falls back to base key when PIPELINE_API_KEY is not set', () => {
      process.env.ANTHROPIC_API_KEY = 'base-key';
      expect(getProviderApiKey('anthropic', 'pipeline')).toBe('base-key');
    });

    test('returns undefined when neither workload nor base key is set', () => {
      expect(getProviderApiKey('anthropic', 'pipeline')).toBeUndefined();
    });
  });

  describe('workload isolation', () => {
    test('conversation key does not leak to pipeline workload', () => {
      process.env.CONVERSATION_API_KEY = 'conv-only';
      process.env.ANTHROPIC_API_KEY = 'base';
      expect(getProviderApiKey('anthropic', 'pipeline')).toBe('base');
    });

    test('pipeline key does not leak to conversation workload', () => {
      process.env.PIPELINE_API_KEY = 'pipe-only';
      process.env.ANTHROPIC_API_KEY = 'base';
      expect(getProviderApiKey('anthropic', 'conversation')).toBe('base');
    });

    test('workload keys do not leak to undefined workload', () => {
      process.env.CONVERSATION_API_KEY = 'conv';
      process.env.PIPELINE_API_KEY = 'pipe';
      process.env.ANTHROPIC_API_KEY = 'base';
      expect(getProviderApiKey('anthropic')).toBe('base');
    });
  });
});

describe('getConfigSummary', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const summaryKeys = [
    'CONVERSATION_API_KEY', 'PIPELINE_API_KEY',
    'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY', 'LLM_API_KEY', 'CODING_API_KEY_1',
    'JWT_SECRET', 'ENCRYPTION_KEY',
    'DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY',
  ];

  beforeEach(() => {
    for (const key of summaryKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of summaryKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  test('includes CONVERSATION_API_KEY when set', () => {
    const fakeKey = ['a','a','a','a','1','1','1','1','b','b','b','b','2','2','2','2','c','c','c','c'].join('');
    process.env.CONVERSATION_API_KEY = fakeKey;
    const summary = getConfigSummary();
    expect(summary.CONVERSATION_API_KEY).toBe('aaaa...cccc');
  });

  test('includes PIPELINE_API_KEY when set', () => {
    const fakeKey = ['d','d','d','d','3','3','3','3','e','e','e','e','4','4','4','4','f','f','f','f'].join('');
    process.env.PIPELINE_API_KEY = fakeKey;
    const summary = getConfigSummary();
    expect(summary.PIPELINE_API_KEY).toBe('dddd...ffff');
  });

  test('does not include keys that are not set', () => {
    const summary = getConfigSummary();
    expect(summary.CONVERSATION_API_KEY).toBeUndefined();
    expect(summary.PIPELINE_API_KEY).toBeUndefined();
  });

  test('masks short keys with ****', () => {
    process.env.CONVERSATION_API_KEY = 'short';
    const summary = getConfigSummary();
    expect(summary.CONVERSATION_API_KEY).toBe('****');
  });
});
