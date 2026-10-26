import { describe, expect, it } from 'vitest';
import { assertExposurePolicy, isExternalExposure } from '../exposure-policy.js';

const local = { HOST: '127.0.0.1', NODE_ENV: 'production' } as const;

describe('assertExposurePolicy', () => {
  it.each([
    [{ ...local, STUDIO_AUTH: 'none' }],
    [{ ...local, STUDIO_AUTH: 'on' }],
    [{ ...local, STUDIO_AUTH: 'on', STUDIO_EXTERNAL_EXPOSURE: 'true' }],
    [{ ...local, STUDIO_AUTH: 'on', STUDIO_TRUSTED_REVERSE_PROXY: 'true' }],
    [{ ...local, STUDIO_AUTH: 'on', CLOUDFLARED_ENABLED: 'true' }],
    [{ HOST: '0.0.0.0', STUDIO_AUTH: 'on', NODE_ENV: 'development' }],
  ])('allows an authenticated or explicitly local-only combination: %o', (env) => {
    expect(() => assertExposurePolicy(env)).not.toThrow();
  });

  it.each([
    [{ ...local, STUDIO_AUTH: 'none', CLOUDFLARED_ENABLED: 'true' }],
    [{ ...local, STUDIO_AUTH: 'none', STUDIO_EXTERNAL_EXPOSURE: 'true' }],
    [{ ...local, STUDIO_AUTH: 'none', STUDIO_TRUSTED_REVERSE_PROXY: 'true' }],
    [{ HOST: '0.0.0.0', STUDIO_AUTH: 'none', NODE_ENV: 'development' }],
    [{ ...local, STUDIO_AUTH: 'on', STUDIO_EXTERNAL_EXPOSURE: 'true', REGISTER_ENABLED: 'true' }],
    [{ ...local, STUDIO_AUTH: 'on', STUDIO_TRUSTED_REVERSE_PROXY: 'true', REGISTER_ENABLED: 'true' }],
    [{ ...local, STUDIO_AUTH: 'on', CLOUDFLARED_ENABLED: 'true', REGISTER_ENABLED: 'true' }],
    [{ HOST: '0.0.0.0', STUDIO_AUTH: 'on', NODE_ENV: 'production', REGISTER_ENABLED: 'true' }],
    [{ ...local, STUDIO_AUTH: 'unexpected' }],
  ])('fails closed for an unsafe combination: %o', (env) => {
    expect(() => assertExposurePolicy(env)).toThrow();
  });

  it('does not treat loopback without a tunnel as proof against a declared reverse proxy', () => {
    expect(isExternalExposure({ ...local, STUDIO_TRUSTED_REVERSE_PROXY: 'true' })).toBe(true);
    expect(isExternalExposure({ ...local, STUDIO_TRUSTED_REVERSE_PROXY: 'false' })).toBe(false);
  });

  it.each(['STUDIO_EXTERNAL_EXPOSURE', 'STUDIO_TRUSTED_REVERSE_PROXY', 'CLOUDFLARED_ENABLED'] as const)(
    'rejects an ambiguous boolean declaration: %s',
    (key) => {
      expect(() => assertExposurePolicy({ ...local, STUDIO_AUTH: 'on', [key]: 'yes' })).toThrow(/boolean/i);
    },
  );
});
