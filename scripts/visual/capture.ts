// 页面截图采集 CLI（#391）：12 页 × 1920/1440/1280 三档默认态，一轮一个 run 目录
// 用法：VISUAL_REFRESH_TOKEN=<token> npx tsx scripts/visual/capture.ts --name <run>
//   --base-url  前端地址（默认 http://localhost:13000/dev/，dev:start 的形态）
//   --api-url   API 地址（默认 http://localhost:13001）
//   输出：.studio/visual/<run>/<page>-<width>.png（.studio/* 已 gitignore，不入库）
// 认证：refresh token → POST /api/v1/auth/refresh 换 access token → 种 localStorage
//   auth-storage（zustand persist 形态，见 apps/web/src/api/index.ts getStoredAuth）。
//   token 只走环境变量，禁止写入代码/配置/报告（public_repo_sanitization）。
// 稳定化（#390 决议）：reducedMotion + animations:'disabled' + setFixedTime 假时钟
//   + 拍前注入 [data-visual-ignore]{visibility:hidden} 隐藏已知动态组件。
// 交互态扩展位（§10.4）：下方 PREPARE 表按页面名注册 prepare(page) 钩子——
//   拍默认态后执行交互（开 modal/下拉/角标），再拍 <page>-<state>-<width>.png。
//   本票只留机制，交互态按 implement 票需要逐个加。
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { pathToFileURL } from 'node:url';
import { PAGES, WIDTHS, HEIGHTS, RUNS_DIR, FIXED_TIME, shotFileName, type PageParam } from './config';

/** §10.4 交互态补拍注册表：key = 页面名，value = [状态名, 交互动作] 列表 */
const PREPARE: Record<string, Array<[string, (page: Page) => Promise<void>]>> = {
  // 例：'knowledge': [['select-open', async page => { await page.getByRole('combobox').click(); }]],
};

const HIDE_DYNAMIC_CSS = '[data-visual-ignore]{visibility:hidden!important}';

interface AuthTokens { token: string; refreshToken: string }

async function exchangeToken(apiUrl: string, refreshToken: string): Promise<AuthTokens> {
  const res = await fetch(`${apiUrl}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) throw new Error(`refresh 换 token 失败：HTTP ${res.status}`);
  const data = await res.json() as { accessToken?: string; refreshToken?: string };
  if (!data.accessToken || !data.refreshToken) throw new Error('refresh 响应缺 token 字段');
  return { token: data.accessToken, refreshToken: data.refreshToken };
}

/** 带参页面目标 id 运行时发现：各列表 API 取第一条。响应形态各模块不一，逐路径探测 */
export function firstId(json: unknown, ...paths: string[]): string | undefined {
  for (const p of paths) {
    const list = p.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], json);
    if (Array.isArray(list) && list.length > 0) {
      const id = (list[0] as Record<string, unknown>).id;
      if (typeof id === 'string') return id;
    }
  }
  return undefined;
}

async function discoverParams(apiUrl: string, token: string): Promise<Partial<Record<PageParam, string>>> {
  const get = async (path: string): Promise<unknown> => {
    const res = await fetch(`${apiUrl}/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GET ${path} 失败：HTTP ${res.status}`);
    return res.json();
  };

  const [channels, pmo, workunits, agents] = await Promise.all([
    get('/channels'), get('/pmo/project'), get('/workunits'), get('/agent-profiles'),
  ]);
  return {
    channelId: firstId(channels, 'data'),
    pmoId: firstId(pmo, 'data'),
    workUnitId: firstId(workunits, 'data.workunits', 'data'),
    agentProfileId: firstId(agents, 'data'),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const runName = opt('name');
  if (!runName) {
    console.error('用法：npx tsx scripts/visual/capture.ts --name <run> [--base-url <url>] [--api-url <url>]');
    process.exit(1);
  }
  const baseUrl = (opt('base-url') ?? 'http://localhost:13000/dev/').replace(/\/?$/, '/');
  const apiUrl = opt('api-url') ?? 'http://localhost:13001';
  const refreshToken = process.env.VISUAL_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('缺 VISUAL_REFRESH_TOKEN 环境变量（dev 数据根既有用户的 refreshToken）');

  const tokens = await exchangeToken(apiUrl, refreshToken);
  const params = await discoverParams(apiUrl, tokens.token);

  const outDir = resolve(RUNS_DIR, runName);
  mkdirSync(outDir, { recursive: true });

  // 默认用 playwright 自带 chromium；环境缺浏览器时 VISUAL_BROWSER_CHANNEL=chrome 走系统 Chrome
  const browser = await chromium.launch({ channel: process.env.VISUAL_BROWSER_CHANNEL || undefined });
  let shot = 0;
  try {
    for (const width of WIDTHS) {
      const context = await browser.newContext({
        viewport: { width, height: HEIGHTS[width] },
        reducedMotion: 'reduce',
        baseURL: baseUrl,
      });
      // 种 auth-storage：zustand persist 形态 {state:{token,refreshToken},version:0}
      await context.addInitScript(([t]) => {
        localStorage.setItem('auth-storage', JSON.stringify({
          state: { token: t.token, refreshToken: t.refreshToken, user: null },
          version: 0,
        }));
      }, [tokens]);

      for (const target of PAGES) {
        if (target.param && !params[target.param]) {
          console.warn(`跳过 ${target.name}：API 未发现 ${target.param}`);
          continue;
        }
        const path = target.param
          ? target.path.replace(`:${target.param}`, params[target.param]!)
          : target.path;

        const page = await context.newPage();
        await page.clock.setFixedTime(FIXED_TIME);
        await page.goto(path.replace(/^\//, ''), { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { /* SSE 长连接常驻，networkidle 兜底超时即可 */ });
        // 等加载态消失（首轮 diff 归因：major 全部来自"加载中/Loading..."竞态）。
        // 频道页右侧栏常驻"加载中…"（无实例空态），超时可接受——两轮等同样时长，结果仍一致
        await page.waitForFunction(
          () => !document.body.innerText.includes('加载中') && !document.body.innerText.includes('Loading'),
          null,
          { timeout: 4000 },
        ).catch(() => { /* 常驻加载态页兜底 */ });
        await page.waitForTimeout(800); // 渲染沉降，两轮一致即可
        await page.addStyleTag({ content: HIDE_DYNAMIC_CSS });

        await page.screenshot({
          path: join(outDir, shotFileName(target.name, width)),
          animations: 'disabled',
        });
        shot++;

        // §10.4 交互态补拍扩展位：PREPARE 注册了该页状态时逐个执行并加拍
        for (const [state, prepare] of PREPARE[target.name] ?? []) {
          await prepare(page);
          await page.addStyleTag({ content: HIDE_DYNAMIC_CSS });
          await page.screenshot({
            path: join(outDir, shotFileName(`${target.name}-${state}`, width)),
            animations: 'disabled',
          });
          shot++;
        }
        await page.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`完成：${shot} 张 → ${outDir}`);
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
