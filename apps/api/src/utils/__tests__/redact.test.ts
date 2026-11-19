import { describe, expect, it } from 'vitest';
import { redactSensitive } from '../redact.js';

describe('redactSensitive', () => {
  it('recursively redacts credential keys in objects and arrays without mutating input', () => {
    const input = {
      token: 'query-secret',
      nested: [
        { access_token: 'access-secret', keep: 1 },
        { refresh_token: 'refresh-secret', authorization: 'Bearer secret' },
        { accessToken: 'camel-access', refreshToken: 'camel-refresh' },
      ],
    };
    const redacted = redactSensitive(input);
    expect(redacted).toEqual({
      token: '[REDACTED]',
      nested: [
        { access_token: '[REDACTED]', keep: 1 },
        { refresh_token: '[REDACTED]', authorization: '[REDACTED]' },
        { accessToken: '[REDACTED]', refreshToken: '[REDACTED]' },
      ],
    });
    expect(input.token).toBe('query-secret');
    expect(JSON.stringify(redacted)).not.toContain('secret');
  });

  it('preserves ordinary nested values and key case-insensitive matching', () => {
    expect(redactSensitive({ Authorization: 'secret', safe: { value: true } })).toEqual({
      Authorization: '[REDACTED]', safe: { value: true },
    });
  });
});
