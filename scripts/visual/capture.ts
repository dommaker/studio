// 页面截图采集 CLI（#391）：12 页 × 1920/1440/1280 三档默认态，一轮一个 run 目录
// 用法：VISUAL_REFRESH_TOKEN=<token> npx tsx scripts/visual/capture.ts --name <run>
//   --widths    逗号分隔覆盖宽度档（如 1024,768,640,375 窄屏走查，#395；须在 config HEIGHTS 登记高度）
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
import { PAGES, B_PAGES, WIDTHS, B_WIDTHS, HEIGHTS, RUNS_DIR, FIXED_TIME, shotFileName, type PageParam, type PageTarget } from './config';

/** §10.4 交互态补拍注册表（#400 点名清单）：key = 页面名，value = [状态名, 交互动作] 列表；
    动作返回 false 表示该状态下不拍（数据前置不满足 / 窄屏入口隐藏）。
    需要运行时数据的（in_review WU id / studio 角色 provider 翻牌还原）走工厂闭包。 */
export function buildPrepare(extra: { inReviewWorkUnitId?: string }): Record<string, Array<[string, (page: Page) => Promise<boolean>]>> {
  /** 关掉当前打开的 modal（footer 取消/关闭 > header ×），供同页连续交互态复位 */
  const closeModal = async (page: Page): Promise<void> => {
    const btn = page.getByRole('button', { name: '取消' })
      .or(page.locator('.modal-footer').getByRole('button', { name: '关闭' }))
      .or(page.locator('.modal-close'));
    if (await btn.count() > 0) await btn.first().click().catch(() => { /* 已关 */ });
    await page.waitForTimeout(200);
  };

  /** studio 角色 provider 翻牌还原值（modal-studio-role-setup 置 null 后由 restore 还原） */
  let flippedStudioProvider: string | null = null;
  const patchStudioProvider = async (page: Page, provider: string | null): Promise<boolean> => {
    return page.evaluate(async (p) => {
      const raw = localStorage.getItem('auth-storage');
      if (!raw) return false;
      const token = JSON.parse(raw).state.token;
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const res = await fetch('/api/v1/agent-profiles?includeSystem=true', { headers });
      const studio = ((await res.json()).data as Array<{ id: string; name: string }>).find(x => x.name === 'studio');
      if (!studio) return false;
      const patch = await fetch(`/api/v1/agent-profiles/${studio.id}`, { method: 'PATCH', headers, body: JSON.stringify({ provider: p }) });
      return patch.ok;
    }, provider);
  };

  return {
    // <1024 窄屏走查（#395 §4.6）：顶栏「频道动态」入口开右侧覆盖抽屉；≥1024 入口 CSS 隐藏 → 跳拍
    'channel-detail': [
      ['act-open', async page => {
        const btn = page.getByLabel('打开频道动态');
        if (!(await btn.isVisible())) return false;
        await btn.click();
        await page.getByRole('dialog', { name: '频道动态' }).waitFor({ state: 'visible', timeout: 3000 });
        return true;
      }],
    ],
    // #400 modal 族实例：WorkspacePage 创建角色（24rem）
    'workspace': [
      ['modal-create-role', async page => {
        try {
          const btn = page.getByRole('button', { name: '设为角色' }).first();
          await btn.waitFor({ state: 'visible', timeout: 3000 });
          await btn.click();
          await page.locator('.modal-overlay:has-text("创建角色")').waitFor({ state: 'visible', timeout: 3000 });
          return true;
        } catch {
          return false;
        }
      }],
    ],
    // #400 modal 族实例：拒绝原因（24rem）+ AnalysisApproveDialog（28rem）；数据变体：超长 scope truncate
    'workunits': [
      ['modal-reject', async page => {
        const btn = page.getByRole('button', { name: '拒绝', exact: true }).first();
        if (!(await btn.isVisible().catch(() => false))) return false;
        await btn.click();
        await page.locator('.modal-overlay:has-text("拒绝原因")').waitFor({ state: 'visible', timeout: 3000 });
        return true;
      }],
      ['modal-approve', async page => {
        await closeModal(page);
        const btn = page.getByRole('button', { name: '通过', exact: true }).first();
        if (!(await btn.isVisible().catch(() => false))) return false;
        await btn.click();
        await page.locator('.modal-overlay:has-text("确认分析结论")').waitFor({ state: 'visible', timeout: 3000 });
        return true;
      }],
      ['long-scope', async page => {
        await closeModal(page);
        // 真实响应改第一行 scope 为超长文本（保字段全真，只放长 truncate 对象）
        await page.route(/\/api\/v1\/workunits(\?|$)/, async route => {
          const res = await route.fetch();
          const json = await res.json() as { data?: Array<{ scope?: string }> };
          if (Array.isArray(json.data) && json.data.length > 0) {
            json.data[0].scope = 'REQ-超长标题变体：'.repeat(2) + '这是一个用于验证标题 truncate 后可辨认性的超长 WorkUnit scope 文本，'.repeat(3) + '末尾标记-END';
          }
          await route.fulfill({ response: res, json });
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitSettled(page);
        return true;
      }],
    ],
    // #400 modal 族实例：详情页拒绝原因（当前 WU 非 in_review 时导航到运行时发现的那个）
    'workunit-detail': [
      ['modal-reject', async page => {
        const btn = page.getByRole('button', { name: '拒绝', exact: true }).first();
        let ok = await btn.waitFor({ state: 'visible', timeout: 1500 }).then(() => true).catch(() => false);
        if (!ok) {
          if (!extra.inReviewWorkUnitId) return false;
          await page.goto(`workunits/${extra.inReviewWorkUnitId}`, { waitUntil: 'domcontentloaded' });
          await waitSettled(page);
          ok = await btn.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
          if (!ok) return false;
        }
        await btn.click();
        await page.locator('.modal-overlay:has-text("拒绝原因")').waitFor({ state: 'visible', timeout: 3000 });
        return true;
      }],
    ],
    // #400 modal 族实例：日志详情（672px）；共享件：Select 下拉；数据变体：空态
    'audit-logs': [
      ['modal-log-detail', async page => {
        const row = page.locator('tbody tr').first();
        if (!(await row.isVisible().catch(() => false))) return false;
        await row.click();
        await page.locator('.modal-overlay:has-text("日志详情")').waitFor({ state: 'visible', timeout: 3000 });
        return true;
      }],
      ['select-open', async page => {
        await closeModal(page);
        const trigger = page.locator('.select-trigger').first();
        if (!(await trigger.isVisible().catch(() => false))) return false;
        await trigger.click();
        await page.locator('.select-panel').waitFor({ state: 'visible', timeout: 3000 });
        return true;
      }],
      ['empty', async page => {
        await page.keyboard.press('Escape');
        // 只拦列表（带 ? 查询串），stats/actions/resources 放行
        await page.route(/\/api\/v1\/audit-logs\?/, route => route.fulfill({
          json: { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } },
        }));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByText('暂无审计日志').waitFor({ state: 'visible', timeout: 5000 }).catch(() => { /* 兜底仍拍 */ });
        await waitSettled(page);
        return true;
      }],
    ],
    // #400 共享件：NotificationBell 下拉+未读角标、MoreDropdown；modal 族实例：StudioRoleSetupModal（400px，provider 翻牌触发，随后还原）
    'settings': [
      ['bell-open', async page => {
        const btn = page.getByTitle('通知中心');
        if (!(await btn.isVisible().catch(() => false))) return false;
        await btn.click();
        await page.locator('div.w-80').waitFor({ state: 'visible', timeout: 3000 });
        // 角标/时间戳默认被 data-visual-ignore 隐藏；本态点名查角标，揭开（后注入的同优先级规则生效）
        await page.addStyleTag({ content: '[data-visual-ignore]{visibility:visible!important}' });
        return true;
      }],
      ['more-open', async page => {
        try {
          await page.keyboard.press('Escape');
          await page.mouse.click(10, 10).catch(() => { /* 点空白收下拉 */ });
          // TopNav 桌面/移动双实例各挂一个「更多」触发钮，取第一个可见的
          const btn = page.getByRole('button', { name: /更多/ }).first();
          await btn.waitFor({ state: 'visible', timeout: 2000 });
          await btn.click();
          await page.locator('div.w-52').waitFor({ state: 'visible', timeout: 3000 });
          return true;
        } catch {
          return false;
        }
      }],
      ['modal-studio-role-setup', async page => {
        // 触发条件 = studio 角色 provider=null 且本 session 未 dismiss：翻牌 → reload 自动弹
        const raw = await page.evaluate(() => {
          const token = JSON.parse(localStorage.getItem('auth-storage')!).state.token as string;
          return fetch('/api/v1/agent-profiles?includeSystem=true', { headers: { Authorization: `Bearer ${token}` } })
            .then(r => r.json())
            .then(d => (d.data as Array<{ name: string; provider: string | null }>).find(x => x.name === 'studio')?.provider ?? null);
        });
        if (!raw) return false;
        if (!(await patchStudioProvider(page, null))) return false;
        flippedStudioProvider = raw;
        await page.reload({ waitUntil: 'domcontentloaded' });
        const ok = await page.locator('.modal-overlay:has-text("系统执行角色未配置")')
          .waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
        if (!ok) { await patchStudioProvider(page, flippedStudioProvider); flippedStudioProvider = null; return false; }
        return true;
      }],
      ['restore-studio-provider', async page => {
        if (flippedStudioProvider) await patchStudioProvider(page, flippedStudioProvider);
        flippedStudioProvider = null;
        return false; // 只还原，不拍
      }],
      // #400 共享件：toast 四型（duration:0 常驻；vite dev 原生 ESM 动态 import，base 前缀两种都试）
      ['toast', async page => {
        try {
          await page.keyboard.press('Escape');
          await page.mouse.click(10, 10).catch(() => { /* 收可能挂着的下拉 */ });
          await page.evaluate(async () => {
            // new Function 绕开 tsc 对动态 import 字面量的模块解析（路径只在 vite dev 运行时有意义）
            const importer = new Function('p', 'return import(p)') as (p: string) => Promise<{ toast: Record<'success' | 'error' | 'warning' | 'info', (msg: string, opts?: { duration?: number }) => void> }>;
            const m = await importer('/src/utils/toast.ts').catch(() => importer('/dev/src/utils/toast.ts'));
            m.toast.success('操作成功：任务已验收', { duration: 0 });
            m.toast.error('操作失败：网络异常，请稍后重试', { duration: 0 });
            m.toast.warning('提醒：注入预算占用超过八成', { duration: 0 });
            m.toast.info('提示：这是一条信息通知', { duration: 0 });
          });
          await page.locator('#toast-container > div').first().waitFor({ state: 'visible', timeout: 3000 });
          return true;
        } catch {
          return false;
        }
      }],
    ],
    // #400 B 档：登录弹框 AuthModal（24rem，双击 ⚡ 或 Ctrl+Enter 开）
    'landing': [
      ['auth-open', async page => {
        await page.keyboard.press('Control+Enter');
        const ok = await page.locator('.modal-overlay').waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
        return ok;
      }],
    ],
  };
}

/** --widths 参数解析：未传 → 默认宽度档（tier B 两档，A 三档）；逗号分隔，每档须在 HEIGHTS 登记视口高度 */
export function parseWidths(arg: string | undefined, tier: 'A' | 'B' = 'A'): number[] {
  if (!arg) return [...(tier === 'B' ? B_WIDTHS : WIDTHS)];
  const widths = arg.split(',').map(s => Number(s.trim()));
  for (const w of widths) {
    if (!Number.isInteger(w) || !(w in HEIGHTS)) {
      throw new Error(`未知宽度档 ${w}（--widths ${arg}）：需在 config.ts HEIGHTS 登记对应视口高度`);
    }
  }
  return widths;
}

/** --tier 参数解析（#400）：A = 认证页（默认），B = 未认证页（不种 auth、不要求 token） */
export function parseTier(arg: string | undefined): 'A' | 'B' {
  if (arg === undefined) return 'A';
  if (arg === 'A' || arg === 'B') return arg;
  throw new Error(`未知 tier ${arg}：只支持 A（认证页）/ B（未认证页）`);
}

/** 带参路径填值：id 经 encodeURIComponent（libraryDocId 含 / 与 :，react-router 侧 decode 回原文） */
export function fillPath(target: PageTarget, params: Partial<Record<PageParam, string>>): string {
  if (!target.param) return target.path;
  return target.path.replace(`:${target.param}`, encodeURIComponent(params[target.param]!));
}

const HIDE_DYNAMIC_CSS = '[data-visual-ignore]{visibility:hidden!important}';

/** 拍前沉降（#400 加固）：等认证水合（A 档 guest splash 消失）+ 加载文案消失 + spinner 消失。
    旧版只等「加载中」文案 4s：splash（auth 水合中）与 PageLoader spinner（无文案）都会漏等，
    慢页（library/workspace/setup-roles）拍出加载态。10s 兜底——常驻加载态页（频道右栏）超时放过。 */
export async function waitSettled(page: Page, tier: 'A' | 'B' = 'A'): Promise<void> {
  await page.waitForFunction(
    (isA) => {
      const text = document.body.innerText;
      if (isA && text.includes('我的 AI 开发助手')) return false; // guest splash = auth 尚未水合
      if (text.includes('加载中') || text.includes('Loading')) return false;
      return !document.querySelector('.animate-spin');
    },
    tier === 'A',
    { timeout: 20000 }, // settings 页串行拉 ~10 个慢 API（/workspaces/runtimes 单发 ~2.5s），实测沉降 8s+
  ).catch(() => { /* 常驻加载态页兜底 */ });
  await page.waitForTimeout(800); // 渲染沉降，两轮一致即可
}

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

async function discoverParams(apiUrl: string, token: string): Promise<{ params: Partial<Record<PageParam, string>>; inReviewWorkUnitId?: string }> {
  const get = async (path: string): Promise<unknown> => {
    const res = await fetch(`${apiUrl}/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GET ${path} 失败：HTTP ${res.status}`);
    return res.json();
  };

  const [channels, pmo, workunits, agents, library, workspaces] = await Promise.all([
    get('/channels'), get('/pmo/project'), get('/workunits'), get('/agent-profiles'),
    get('/library'), get('/workspaces'),
  ]);
  // #400 交互态前置：运行时发现一个 in_review WU（拒绝/通过 modal 的触发对象）
  const wuList = (workunits as { data?: { workunits?: Array<{ id?: string; status?: string }> } | Array<{ id?: string; status?: string }> })?.data;
  const wuArr = Array.isArray(wuList) ? wuList : wuList?.workunits ?? [];
  const inReviewWorkUnitId = wuArr.find(w => w?.status === 'in_review')?.id;
  return {
    params: {
      channelId: firstId(channels, 'data'),
      pmoId: firstId(pmo, 'data'),
      workUnitId: firstId(workunits, 'data.workunits', 'data'),
      agentProfileId: firstId(agents, 'data'),
      libraryDocId: firstId(library, 'data'),
      workspaceId: firstId(workspaces, 'data'),
    },
    inReviewWorkUnitId,
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
    console.error('用法：npx tsx scripts/visual/capture.ts --name <run> [--tier A|B] [--widths 1920,1440] [--base-url <url>] [--api-url <url>]');
    process.exit(1);
  }
  const tier = parseTier(opt('tier'));
  const targets = tier === 'B' ? B_PAGES : PAGES;
  const baseUrl = (opt('base-url') ?? 'http://localhost:13000/dev/').replace(/\/?$/, '/');
  const apiUrl = opt('api-url') ?? 'http://localhost:13001';
  const widths = parseWidths(opt('widths'), tier);

  // B 档 = 未认证页：不种 auth-storage、不要求 token、不做参数发现
  let tokens: AuthTokens | undefined;
  let params: Partial<Record<PageParam, string>> = {};
  let inReviewWorkUnitId: string | undefined;
  if (tier === 'A') {
    const refreshToken = process.env.VISUAL_REFRESH_TOKEN;
    if (!refreshToken) throw new Error('缺 VISUAL_REFRESH_TOKEN 环境变量（dev 数据根既有用户的 refreshToken）');
    tokens = await exchangeToken(apiUrl, refreshToken);
    const discovered = await discoverParams(apiUrl, tokens.token);
    params = discovered.params;
    inReviewWorkUnitId = discovered.inReviewWorkUnitId;
  }
  const prepare = buildPrepare({ inReviewWorkUnitId });

  const outDir = resolve(RUNS_DIR, runName);
  mkdirSync(outDir, { recursive: true });

  // 默认用 playwright 自带 chromium；环境缺浏览器时 VISUAL_BROWSER_CHANNEL=chrome 走系统 Chrome
  const browser = await chromium.launch({ channel: process.env.VISUAL_BROWSER_CHANNEL || undefined });
  let shot = 0;
  try {
    for (const width of widths) {
      const context = await browser.newContext({
        viewport: { width, height: HEIGHTS[width] },
        reducedMotion: 'reduce',
        baseURL: baseUrl,
      });
      // 种 auth-storage：zustand persist 形态 {state:{token,refreshToken},version:0}（仅 A 档）
      if (tokens) {
        await context.addInitScript(([t]) => {
          localStorage.setItem('auth-storage', JSON.stringify({
            state: { token: t.token, refreshToken: t.refreshToken, user: null },
            version: 0,
          }));
        }, [tokens]);
      }

      for (const target of targets) {
        if (target.param && !params[target.param]) {
          console.warn(`跳过 ${target.name}：API 未发现 ${target.param}`);
          continue;
        }
        const path = fillPath(target, params);

        const page = await context.newPage();
        await page.clock.setFixedTime(FIXED_TIME);
        await page.goto(path.replace(/^\//, ''), { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { /* SSE 长连接常驻，networkidle 兜底超时即可 */ });
        await waitSettled(page, tier);
        await page.addStyleTag({ content: HIDE_DYNAMIC_CSS });

        await page.screenshot({
          path: join(outDir, shotFileName(target.name, width)),
          animations: 'disabled',
        });
        shot++;

        // §10.4 交互态补拍扩展位：buildPrepare 注册了该页状态时逐个执行并加拍。
        // 不再重复注入 HIDE_DYNAMIC_CSS（默认态注入持续生效；bell-open 等态需揭开角标，
        // 重复注入会盖掉 prepare 里的 visibility 还原）
        for (const [state, prepareFn] of prepare[target.name] ?? []) {
          if (!(await prepareFn(page))) continue;
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
