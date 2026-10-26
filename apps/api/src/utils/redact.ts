const SENSITIVE_KEYS = new Set(['token', 'access_token', 'refresh_token', 'authorization', 'accesstoken', 'refreshtoken']);

/** Return a credential-free copy for application request/audit/error logs; never mutate inputs. */
export function redactSensitive<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value) as T;
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(redactSensitive(item, seen));
    return copy as T;
  }
  if (typeof value !== 'object' || value === null || value instanceof Date || ArrayBuffer.isView(value)) return value;
  if (seen.has(value)) return seen.get(value) as T;
  const copy: Record<string, unknown> = Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const key of Object.getOwnPropertyNames(value)) {
    const item = (value as Record<string, unknown>)[key];
    copy[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redactSensitive(item, seen);
  }
  return copy as T;
}
