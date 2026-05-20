// E2E Auth Setup — 获取 guest token，保存到浏览器上下文
import { test as setup } from '@playwright/test';
import { writeFileSync } from 'fs';

const AUTH_FILE = 'e2e/.auth.json';

setup('authenticate via guest endpoint', async ({ request }) => {
  const res = await request.post('http://localhost:13001/api/v1/auth/guest-session', {
    data: { name: 'e2e-test-user' },
  });
  const data = await res.json();
  const token = (data as any).session?.token || (data as any).token;
  if (!token) throw new Error('Failed to get guest token: ' + JSON.stringify(data));

  // Save token + cookies to file (Playwright StorageState format)
  const expires = Math.floor(Date.now() / 1000) + 86400; // 24h from now
  writeFileSync(AUTH_FILE, JSON.stringify({
    cookies: [
      {
        name: 'token',
        value: token,
        domain: 'localhost',
        path: '/',
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
        expires,
      },
    ],
    origins: [],
  }));
  console.log('Guest token obtained:', token.slice(0, 20) + '...');
});
