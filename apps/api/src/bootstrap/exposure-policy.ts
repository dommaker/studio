import { isLoopbackHost } from '../cli/listen-host.js';

export type ExposureEnvironment = Readonly<Record<string, string | undefined>>;

function declaredBoolean(env: ExposureEnvironment, key: string): boolean {
  const value = env[key];
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${key} must be a boolean declaration: true or false`);
}

/** Explicit declarations and the actual listener are exposure inputs; loopback alone is not a guarantee. */
export function isExternalExposure(env: ExposureEnvironment): boolean {
  return !isLoopbackHost(env.HOST || '127.0.0.1')
    || declaredBoolean(env, 'CLOUDFLARED_ENABLED')
    || declaredBoolean(env, 'STUDIO_EXTERNAL_EXPOSURE')
    || declaredBoolean(env, 'STUDIO_TRUSTED_REVERSE_PROXY');
}

/** Validate the complete, already-loaded startup configuration before opening any listener. */
export function assertExposurePolicy(env: ExposureEnvironment): void {
  const auth = env.STUDIO_AUTH || 'none';
  if (auth !== 'none' && auth !== 'on') {
    throw new Error('STUDIO_AUTH must be either none or on');
  }
  const external = isExternalExposure(env);
  if (external && auth !== 'on') {
    throw new Error('External exposure requires STUDIO_AUTH=on with an authenticated Operator');
  }
  if (external && env.REGISTER_ENABLED === 'true') {
    throw new Error('REGISTER_ENABLED=true is forbidden on an externally exposed installation');
  }
}
