// #523 浏览器原生通知 util —— 权限三态分支（granted 直发 / default 仅用户手势时请求 / denied 静默）
// mock global Notification 验证各分支行为，不依赖 jsdom 提供 Notification。
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getBrowserNotificationPermission,
  showBrowserNotification,
  requestBrowserNotificationPermission,
  isBrowserNotificationEnabled,
  setBrowserNotificationEnabled,
} from '../browserNotification';

const MockNotification = vi.fn() as unknown as typeof Notification & {
  permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
};

function stubPermission(permission: NotificationPermission) {
  MockNotification.permission = permission;
  MockNotification.requestPermission = vi.fn().mockResolvedValue('granted');
  vi.stubGlobal('Notification', MockNotification);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(MockNotification).mockClear();
  localStorage.clear();
});

describe('getBrowserNotificationPermission', () => {
  it('环境无 Notification（老浏览器/jsdom 缺省）→ unsupported', () => {
    vi.stubGlobal('Notification', undefined);
    expect(getBrowserNotificationPermission()).toBe('unsupported');
  });

  it('有 Notification → 透传当前 permission', () => {
    stubPermission('default');
    expect(getBrowserNotificationPermission()).toBe('default');
  });
});

describe('showBrowserNotification', () => {
  it('granted → new Notification(title, { body })，返回 true', () => {
    stubPermission('granted');

    expect(showBrowserNotification('人闸待确认', '任务「X」待确认超过 30 分钟')).toBe(true);
    expect(MockNotification).toHaveBeenCalledTimes(1);
    expect(MockNotification).toHaveBeenCalledWith('人闸待确认', { body: '任务「X」待确认超过 30 分钟' });
  });

  it('default / denied / unsupported → 不发，返回 false', () => {
    stubPermission('default');
    expect(showBrowserNotification('t', 'b')).toBe(false);
    stubPermission('denied');
    expect(showBrowserNotification('t', 'b')).toBe(false);
    vi.stubGlobal('Notification', undefined);
    expect(showBrowserNotification('t', 'b')).toBe(false);
    expect(MockNotification).not.toHaveBeenCalled();
  });

  it('构造抛错（部分平台 ServiceWorker 限制）→ 静默 false，不向上抛', () => {
    stubPermission('granted');
    vi.mocked(MockNotification).mockImplementationOnce(() => { throw new Error('Illegal constructor'); });
    expect(showBrowserNotification('t', 'b')).toBe(false);
  });
});

describe('isBrowserNotificationEnabled / setBrowserNotificationEnabled（#525 P2-6 总开关）', () => {
  it('缺省（localStorage 无记录）→ 开', () => {
    expect(isBrowserNotificationEnabled()).toBe(true);
  });

  it('set false → 关并持久化；set true → 恢复开', () => {
    setBrowserNotificationEnabled(false);
    expect(isBrowserNotificationEnabled()).toBe(false);
    expect(localStorage.getItem('studio:browser-notifications-enabled')).toBe('false');
    setBrowserNotificationEnabled(true);
    expect(isBrowserNotificationEnabled()).toBe(true);
    expect(localStorage.getItem('studio:browser-notifications-enabled')).toBe('true');
  });

  it('开关关闭时 showBrowserNotification 直接返回 false（granted 也不发）', () => {
    stubPermission('granted');
    setBrowserNotificationEnabled(false);

    expect(showBrowserNotification('人闸待确认', '任务「X」待确认超过 30 分钟')).toBe(false);
    expect(MockNotification).not.toHaveBeenCalled();
  });

  it('开关重新打开后恢复发送', () => {
    stubPermission('granted');
    setBrowserNotificationEnabled(false);
    setBrowserNotificationEnabled(true);

    expect(showBrowserNotification('t', 'b')).toBe(true);
    expect(MockNotification).toHaveBeenCalledTimes(1);
  });
});

describe('requestBrowserNotificationPermission', () => {
  it('default → 调 requestPermission（须由用户手势触发，调用方保证）', async () => {
    stubPermission('default');
    requestBrowserNotificationPermission();
    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('granted / denied / unsupported → 不请求', () => {
    stubPermission('granted');
    requestBrowserNotificationPermission();
    stubPermission('denied');
    requestBrowserNotificationPermission();
    vi.stubGlobal('Notification', undefined);
    requestBrowserNotificationPermission();
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
  });

  it('requestPermission 自身 reject → 静默吞掉（权限请求失败不影响主流程）', async () => {
    stubPermission('default');
    MockNotification.requestPermission = vi.fn().mockRejectedValue(new Error('dismissed'));
    expect(() => requestBrowserNotificationPermission()).not.toThrow();
  });
});
