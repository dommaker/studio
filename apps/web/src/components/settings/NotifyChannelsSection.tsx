// 通知渠道 section（#525 P2-6）：企业微信群机器人 webhook + ClawBot（个人微信）扫码绑定 + 浏览器通知总开关。
// 沿用设置页「组件内即时保存、无保存栏」模式（同 ProjectCandidatesSection）：
// 操作即调 api、成功 toast + 刷新状态、失败 toast.error 带服务端 error 文案。
// ClawBot 绑定 = bind/start 拿 qrcodeUrl（liteapp 网页 URL）→ 前端 qrcode.toDataURL 渲染二维码图
// → 每 2s 轮询 bind/status → confirmed 停止；轮询连续失败 3 次保底停止；卸载清理定时器。
import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { notifyChannelsApi, type ClawbotBindStatus, type NotifyChannelsState } from '../../api/notifyChannels';
import { toast } from '../../utils/toast';
import { serverErrorMessage } from '../../utils/errorMessage';
import {
  getBrowserNotificationPermission,
  isBrowserNotificationEnabled,
  setBrowserNotificationEnabled,
  type BrowserNotificationPermission,
} from '../../utils/browserNotification';
import { SkeletonText } from '../ui';

/** 轮询连续失败保底次数 */
const POLL_MAX_FAILURES = 3;
/** 绑定状态轮询间隔 */
const POLL_INTERVAL_MS = 2000;

const PERMISSION_LABEL: Record<BrowserNotificationPermission, string> = {
  granted: '已授权',
  default: '未请求',
  denied: '已拒绝',
  unsupported: '不支持',
};

export function NotifyChannelsSection() {
  const [state, setState] = useState<NotifyChannelsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [savingWecom, setSavingWecom] = useState(false);
  const [bindSession, setBindSession] = useState<{ qrcode: string; qrImage: string } | null>(null);
  const [bindStatus, setBindStatus] = useState<ClawbotBindStatus>('wait');
  const [bindStarting, setBindStarting] = useState(false);
  const [browserEnabled, setBrowserEnabled] = useState(isBrowserNotificationEnabled);

  const refresh = useCallback(() => {
    return notifyChannelsApi.getStatus()
      .then(res => setState(res.data.data))
      .catch(err => { console.error('Failed to load notify channels:', err); toast.error('加载通知渠道状态失败'); });
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  // ClawBot 绑定状态轮询：bindSession 存在期间每 2s 一次；confirmed / 连续失败保底 / 卸载即停
  useEffect(() => {
    if (!bindSession) return;
    let failures = 0;
    const timer = setInterval(() => {
      notifyChannelsApi.getClawbotBindStatus(bindSession.qrcode)
        .then(res => {
          failures = 0;
          const { status, bound } = res.data.data;
          setBindStatus(status);
          if (status === 'confirmed' && bound) {
            setBindSession(null);
            toast.success('ClawBot 绑定成功');
            refresh();
          }
        })
        .catch(err => {
          failures += 1;
          console.error('Failed to poll clawbot bind status:', err);
          if (failures >= POLL_MAX_FAILURES) {
            setBindSession(null);
            toast.error('绑定状态轮询失败，请重试');
          }
        });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [bindSession, refresh]);

  const saveWecom = (url: string, successText: string) => {
    setSavingWecom(true);
    notifyChannelsApi.saveWecom(url)
      .then(() => { setWebhookUrl(''); toast.success(successText); refresh(); })
      .catch(err => { console.error('Failed to save wecom webhook:', err); toast.error(serverErrorMessage(err) ?? '保存 webhook 失败'); })
      .finally(() => setSavingWecom(false));
  };

  const testWecom = () => {
    notifyChannelsApi.testWecom()
      .then(() => toast.success('测试消息已发送'))
      .catch(err => { console.error('Failed to test wecom:', err); toast.error(serverErrorMessage(err) ?? '发送测试消息失败'); });
  };

  const testClawbot = () => {
    notifyChannelsApi.testClawbot()
      .then(() => toast.success('测试消息已发送'))
      .catch(err => { console.error('Failed to test clawbot:', err); toast.error(serverErrorMessage(err) ?? '发送测试消息失败'); });
  };

  const startBind = () => {
    setBindStarting(true);
    notifyChannelsApi.startClawbotBind()
      .then(async res => {
        const { qrcode, qrcodeUrl } = res.data.data;
        const qrImage = await QRCode.toDataURL(qrcodeUrl);
        setBindStatus('wait');
        setBindSession({ qrcode, qrImage });
      })
      .catch(err => { console.error('Failed to start clawbot bind:', err); toast.error(serverErrorMessage(err) ?? '发起扫码绑定失败'); })
      .finally(() => setBindStarting(false));
  };

  const unbindClawbot = () => {
    notifyChannelsApi.unbindClawbot()
      .then(() => { toast.success('已解绑 ClawBot'); refresh(); })
      .catch(err => { console.error('Failed to unbind clawbot:', err); toast.error(serverErrorMessage(err) ?? '解绑失败'); });
  };

  const toggleBrowser = (enabled: boolean) => {
    setBrowserNotificationEnabled(enabled);
    setBrowserEnabled(enabled);
  };

  const wecom = state?.wecom;
  const clawbot = state?.clawbot;

  return (
    <section className="space-y-4">
      <h2 className="mc-block-label mc-block-label-flush">通知渠道</h2>
      <p className="text-sm u-text-2">
        人闸催办与告警的送达渠道：企业微信群机器人、ClawBot（个人微信）与浏览器原生通知；配置即时保存生效。
      </p>
      <div className="card p-4 space-y-6">
        {loading || !state || !wecom || !clawbot ? (
          <SkeletonText lines={3} className="space-y-2" />
        ) : (
          <>
            {/* 企业微信群机器人 */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium u-text-2">企业微信</h3>
                <span className="text-xs px-1.5 py-0.5 rounded u-text-2">
                  {wecom.configured ? (wecom.source === 'env' ? '环境变量' : '设置页') : '未配置'}
                </span>
              </div>
              {wecom.configured && wecom.maskedUrl && (
                <p className="text-xs u-text-2 truncate">{wecom.maskedUrl}</p>
              )}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={webhookUrl}
                  onChange={e => setWebhookUrl(e.target.value)}
                  placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"
                  className="input flex-1 text-sm"
                />
                <button
                  disabled={savingWecom || !webhookUrl.trim()}
                  onClick={() => saveWecom(webhookUrl.trim(), '企业微信 webhook 已保存')}
                  className="btn btn-primary text-sm shrink-0"
                >保存</button>
                {wecom.configured && wecom.source === 'settings' && (
                  <button
                    disabled={savingWecom}
                    onClick={() => saveWecom('', '企业微信 webhook 已清除')}
                    className="btn btn-secondary text-sm shrink-0"
                  >清除</button>
                )}
                <button
                  disabled={!wecom.configured}
                  onClick={testWecom}
                  aria-label="发送企业微信测试消息"
                  className="btn btn-secondary text-sm shrink-0"
                >发送测试消息</button>
              </div>
            </div>

            {/* ClawBot（个人微信） */}
            <div className="space-y-3">
              <h3 className="text-sm font-medium u-text-2">ClawBot（个人微信）</h3>
              {clawbot.bound ? (
                <>
                  <p className="text-sm u-text-2">已绑定：<span>{clawbot.ilinkUserId}</span></p>
                  <p className="text-xs u-text-2">绑定时间：<span>{clawbot.boundAt}</span></p>
                  <div className="flex items-center gap-2">
                    <button onClick={unbindClawbot} className="btn btn-secondary text-sm">解绑</button>
                    <button
                      onClick={testClawbot}
                      aria-label="发送 ClawBot 测试消息"
                      className="btn btn-secondary text-sm"
                    >发送测试消息</button>
                  </div>
                </>
              ) : bindSession ? (
                <div className="space-y-2">
                  <img src={bindSession.qrImage} alt="ClawBot 绑定二维码" className="w-40 h-40" />
                  <p className="text-sm u-text-2">
                    {bindStatus === 'scaned' ? '已扫码，请在微信中确认' : '用微信扫码确认绑定'}
                  </p>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm u-text-2">未绑定</span>
                  <button
                    disabled={bindStarting}
                    onClick={startBind}
                    className="btn btn-primary text-sm"
                  >扫码绑定</button>
                </div>
              )}
            </div>

            {/* 浏览器原生通知 */}
            <div className="space-y-2">
              <h3 className="text-sm font-medium u-text-2">浏览器通知</h3>
              <label className="flex items-center gap-2 text-sm u-text-2">
                <input
                  type="checkbox"
                  checked={browserEnabled}
                  onChange={e => toggleBrowser(e.target.checked)}
                  aria-label="启用浏览器通知"
                />
                启用浏览器通知
              </label>
              <p className="text-xs u-text-2">权限状态：{PERMISSION_LABEL[getBrowserNotificationPermission()]}</p>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
