import type { NextFunction, Request, Response } from 'express';

function localHostname(value: string, origin: boolean): string | null {
  try {
    const url = new URL(origin ? value : `http://${value}`);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return null;
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost' ? hostname : null;
  } catch {
    return null;
  }
}

/** Local no-login mode still requires a local browser origin; a loopback socket is not enough. */
export function localNetworkGuard(req: Request, res: Response, next: NextFunction): void {
  if ((process.env.STUDIO_AUTH || 'none') !== 'none') return next();
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (
    typeof host !== 'string' || !localHostname(host, false)
    || (origin !== undefined && (typeof origin !== 'string' || !localHostname(origin, true)))
  ) {
    res.status(403).json({ error: { code: 'LOCAL_ORIGIN_REQUIRED', message: 'Local Host and Origin are required' } });
    return;
  }
  next();
}
