// #525 P2-6：设置页「通知渠道」section —— 企业微信 webhook / ClawBot 扫码绑定 / 浏览器通知开关。
// mock notifyChannels client + qrcode.toDataURL + toast；绑定轮询用 fake timers 驱动（同 NotificationBell.test 基建）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const {
  mockGetStatus, mockSaveWecom, mockTestWecom,
  mockStartBind, mockGetBindStatus, mockUnbindClawbot, mockTestClawbot,
  mockToDataURL, mockToastSuccess, mockToastError,
} = vi.hoisted(() => ({
  mockGetStatus: vi.fn(),
  mockSaveWecom: vi.fn(),
  mockTestWecom: vi.fn(),
  mockStartBind: vi.fn(),
  mockGetBindStatus: vi.fn(),
  mockUnbindClawbot: vi.fn(),
  mockTestClawbot: vi.fn(),
  mockToDataURL: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('../../../api/notifyChannels', () => ({
  notifyChannelsApi: {
    getStatus: mockGetStatus,
    saveWecom: mockSaveWecom,
    testWecom: mockTestWecom,
    startClawbotBind: mockStartBind,
    getClawbotBindStatus: mockGetBindStatus,
    unbindClawbot: mockUnbindClawbot,
    testClawbot: mockTestClawbot,
  },
}));

vi.mock('qrcode', () => ({ default: { toDataURL: mockToDataURL } }));

vi.mock('../../../utils/toast', () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

import { NotifyChannelsSection } from '../NotifyChannelsSection';

const WECOM_SETTINGS = { configured: true, maskedUrl: 'https://qyapi.weixin.qq.com/***abc', source: 'settings' as const };
const WECOM_ENV = { configured: true, maskedUrl: 'https://qyapi.weixin.qq.com/***env', source: 'env' as const };
const WECOM_EMPTY = { configured: false, maskedUrl: null, source: null };
const CLAWBOT_BOUND = { bound: true, ilinkUserId: 'ilink-user-1', boundAt: '2026-09-10T08:00:00Z' };
const CLAWBOT_UNBOUND = { bound: false, ilinkUserId: null, boundAt: null };

type Wecom = typeof WECOM_SETTINGS | typeof WECOM_EMPTY;
type Clawbot = typeof CLAWBOT_BOUND | typeof CLAWBOT_UNBOUND;

function stateRes(wecom: Wecom, clawbot: Clawbot) {
  return { data: { success: true, data: { wecom, clawbot } } };
}

/** 服务端 error 信封（axios.isAxiosError 仅校验 isAxiosError 标记） */
function axiosErrorEnvelope(message: string) {
  const err = new Error(`Request failed with status code 400`) as Error & { isAxiosError: boolean; response: unknown };
  err.isAxiosError = true;
  err.response = { status: 400, data: { success: false, error: { message } } };
  return err;
}

describe('#525 P2-6: NotifyChannelsSection 通知渠道', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockGetStatus.mockResolvedValue(stateRes(WECOM_SETTINGS, CLAWBOT_BOUND));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('初始渲染展示企业微信状态（maskedUrl + 来源徽标）与 ClawBot 已绑定信息', async () => {
    render(<NotifyChannelsSection />);

    expect(await screen.findByText('https://qyapi.weixin.qq.com/***abc')).toBeTruthy();
    expect(screen.getByText('设置页')).toBeTruthy();
    expect(screen.getByText('ilink-user-1')).toBeTruthy();
    expect(screen.getByText('2026-09-10T08:00:00Z')).toBeTruthy();
  });

  it('来源为环境变量 → 徽标「环境变量」；未配置/未绑定 → 「未配置」+「扫码绑定」按钮', async () => {
    mockGetStatus.mockResolvedValueOnce(stateRes(WECOM_ENV, CLAWBOT_UNBOUND));
    const { unmount } = render(<NotifyChannelsSection />);
    expect(await screen.findByText('环境变量')).toBeTruthy();
    expect(screen.getByRole('button', { name: '扫码绑定' })).toBeTruthy();
    unmount();

    mockGetStatus.mockResolvedValueOnce(stateRes(WECOM_EMPTY, CLAWBOT_UNBOUND));
    render(<NotifyChannelsSection />);
    expect(await screen.findByText('未配置')).toBeTruthy();
  });

  it('浏览器通知开关：缺省开；切换后持久化到 localStorage', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    render(<NotifyChannelsSection />);
    await screen.findByText('ilink-user-1');

    const toggle = screen.getByRole('checkbox', { name: '启用浏览器通知' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByText(/权限状态：已授权/)).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(localStorage.getItem('studio:browser-notifications-enabled')).toBe('false');

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    expect(localStorage.getItem('studio:browser-notifications-enabled')).toBe('true');
  });

  it('保存 webhook URL → 调 PUT，成功 toast 并刷新状态', async () => {
    mockSaveWecom.mockResolvedValue({ data: { success: true, data: WECOM_SETTINGS } });
    render(<NotifyChannelsSection />);
    await screen.findByText('ilink-user-1');

    fireEvent.change(screen.getByPlaceholderText(/qyapi\.weixin\.qq\.com/), {
      target: { value: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=new' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(mockSaveWecom).toHaveBeenCalledWith('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=new'),
    );
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    // 保存成功后刷新一次状态（挂载 1 次 + 刷新 1 次）
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledTimes(2));
  });

  it('保存失败（400 URL 非法）→ toast.error 带服务端 error 文案', async () => {
    mockSaveWecom.mockRejectedValue(axiosErrorEnvelope('webhook URL 非法'));
    render(<NotifyChannelsSection />);
    await screen.findByText('ilink-user-1');

    fireEvent.change(screen.getByPlaceholderText(/qyapi\.weixin\.qq\.com/), { target: { value: 'not-a-url' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining('webhook URL 非法')));
  });

  it('清除 → PUT 空串', async () => {
    mockSaveWecom.mockResolvedValue({ data: { success: true, data: WECOM_EMPTY } });
    render(<NotifyChannelsSection />);
    await screen.findByText('ilink-user-1');

    fireEvent.click(screen.getByRole('button', { name: '清除' }));

    await waitFor(() => expect(mockSaveWecom).toHaveBeenCalledWith(''));
  });

  it('企业微信测试消息：成功 toast.success；失败 toast.error 带服务端 error', async () => {
    mockTestWecom.mockResolvedValue({ data: { success: true } });
    render(<NotifyChannelsSection />);
    await screen.findByText('ilink-user-1');

    fireEvent.click(screen.getByRole('button', { name: '发送企业微信测试消息' }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('测试消息已发送'));

    mockTestWecom.mockRejectedValue(axiosErrorEnvelope('webhook 送达失败'));
    fireEvent.click(screen.getByRole('button', { name: '发送企业微信测试消息' }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining('webhook 送达失败')));
  });

  it('扫码绑定流：start → 展示二维码 → 轮询 confirmed → toast + 刷新为已绑定并停止轮询', async () => {
    vi.useFakeTimers();
    mockGetStatus.mockReset();
    mockGetStatus
      .mockResolvedValueOnce(stateRes(WECOM_SETTINGS, CLAWBOT_UNBOUND))
      .mockResolvedValue(stateRes(WECOM_SETTINGS, CLAWBOT_BOUND));
    mockStartBind.mockResolvedValue({
      data: { success: true, data: { qrcode: 'qr-1', qrcodeUrl: 'https://liteapp.example.com/bind?t=1' } },
    });
    mockToDataURL.mockResolvedValue('data:image/png;base64,QRIMG');
    mockGetBindStatus.mockResolvedValue({ data: { success: true, data: { status: 'confirmed', bound: true } } });

    render(<NotifyChannelsSection />);
    await act(async () => {}); // 挂载首次 getStatus 完成
    fireEvent.click(screen.getByRole('button', { name: '扫码绑定' }));
    await act(async () => {}); // bind/start + toDataURL 完成

    expect(mockToDataURL).toHaveBeenCalledWith('https://liteapp.example.com/bind?t=1');
    const img = screen.getByAltText('ClawBot 绑定二维码') as HTMLImageElement;
    expect(img.src).toBe('data:image/png;base64,QRIMG');
    expect(screen.getByText(/用微信扫码确认/)).toBeTruthy();

    // 推进 2s → 轮询一次，confirmed → 停止轮询 + toast + 刷新状态
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mockGetBindStatus).toHaveBeenCalledWith('qr-1');
    expect(mockToastSuccess).toHaveBeenCalledWith('ClawBot 绑定成功');
    expect(screen.getByText('ilink-user-1')).toBeTruthy();

    // confirmed 后不再轮询
    mockGetBindStatus.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(mockGetBindStatus).not.toHaveBeenCalled();
  });

  it('扫码后轮询返回 scaned → 提示变为「已扫码，请在微信中确认」', async () => {
    vi.useFakeTimers();
    mockGetStatus.mockReset();
    mockGetStatus.mockResolvedValue(stateRes(WECOM_SETTINGS, CLAWBOT_UNBOUND));
    mockStartBind.mockResolvedValue({
      data: { success: true, data: { qrcode: 'qr-2', qrcodeUrl: 'https://liteapp.example.com/bind?t=2' } },
    });
    mockToDataURL.mockResolvedValue('data:image/png;base64,QRIMG');
    mockGetBindStatus.mockResolvedValue({ data: { success: true, data: { status: 'scaned', bound: false } } });

    render(<NotifyChannelsSection />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '扫码绑定' }));
    await act(async () => {});

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByText(/已扫码，请在微信中确认/)).toBeTruthy();
  });

  it('轮询连续失败 3 次 → 停止轮询并 toast.error 保底', async () => {
    vi.useFakeTimers();
    mockGetStatus.mockReset();
    mockGetStatus.mockResolvedValue(stateRes(WECOM_SETTINGS, CLAWBOT_UNBOUND));
    mockStartBind.mockResolvedValue({
      data: { success: true, data: { qrcode: 'qr-3', qrcodeUrl: 'https://liteapp.example.com/bind?t=3' } },
    });
    mockToDataURL.mockResolvedValue('data:image/png;base64,QRIMG');
    mockGetBindStatus.mockRejectedValue(new Error('network error'));

    render(<NotifyChannelsSection />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '扫码绑定' }));
    await act(async () => {});

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mockToastError).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining('轮询'));

    // 已停止轮询
    mockGetBindStatus.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(mockGetBindStatus).not.toHaveBeenCalled();
  });

  it('组件卸载后停止轮询', async () => {
    vi.useFakeTimers();
    mockGetStatus.mockReset();
    mockGetStatus.mockResolvedValue(stateRes(WECOM_SETTINGS, CLAWBOT_UNBOUND));
    mockStartBind.mockResolvedValue({
      data: { success: true, data: { qrcode: 'qr-4', qrcodeUrl: 'https://liteapp.example.com/bind?t=4' } },
    });
    mockToDataURL.mockResolvedValue('data:image/png;base64,QRIMG');
    mockGetBindStatus.mockResolvedValue({ data: { success: true, data: { status: 'wait', bound: false } } });

    const { unmount } = render(<NotifyChannelsSection />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '扫码绑定' }));
    await act(async () => {});

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mockGetBindStatus).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(mockGetBindStatus).toHaveBeenCalledTimes(1);
  });

  it('解绑 → 调 unbind，成功 toast 并刷新状态', async () => {
    mockUnbindClawbot.mockResolvedValue({ data: { success: true } });
    render(<NotifyChannelsSection />);
    await screen.findByText('ilink-user-1');

    fireEvent.click(screen.getByRole('button', { name: '解绑' }));

    await waitFor(() => expect(mockUnbindClawbot).toHaveBeenCalled());
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledTimes(2));
  });
});
