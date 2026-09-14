/**
 * 企业微信群机器人 markdown 发送唯一出口（#525 review 收口）：
 * utils/notifier.ts 告警 sink 与本模块 /wecom/test 测试发送共用，不再各自拼 fetch。
 * 非 2xx 不抛（返回 status 由调用方处置）；网络/超时错误抛出由调用方兜底。
 */
const WECOM_TIMEOUT_MS = 5_000;

export interface WeComPostResult {
  ok: boolean;
  status: number;
}

/** POST markdown 到群机器人 webhook（5s 超时） */
export async function postWeComMarkdown(url: string, content: string): Promise<WeComPostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WECOM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}
