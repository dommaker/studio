// toast 进出场 fade（批次 E-3 已批治理项）：进场 opacity 0→1、出场 1→0 过渡结束后移除、幂等关闭
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toast } from '../toast';

const toasts = () => Array.from(document.querySelectorAll('#toast-container > div')) as HTMLElement[];

describe('toast 进出场 fade（批次 E-3）', () => {
  beforeEach(async () => {
    // 清场上个用例残留（dismiss 走 150ms 淡出后异步移除）
    toast.dismiss();
    vi.useRealTimers();
    if (toasts().length > 0) await new Promise(r => setTimeout(r, 250));
  });
  afterEach(() => {
    vi.useRealTimers();
    toast.dismiss();
  });

  it('进场：挂载时 opacity:0 + opacity 过渡，下一帧置 1 触发 fade-in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    toast.success('已保存');
    const el = toasts()[0];
    expect(el).toBeTruthy();
    expect(el.style.opacity).toBe('0');
    expect(el.style.transition).toContain('opacity');
    expect(el.style.transition).toContain('var(--motion-base)');
    // rAF 不在 fake 范围：等真实下一帧
    await new Promise(r => requestAnimationFrame(r));
    expect(el.style.opacity).toBe('1');
  });

  it('出场：duration 到期先 opacity→0（不立即移除），过渡时长后才 remove', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    toast.error('失败了', { duration: 1000 });
    const el = toasts()[0];
    vi.advanceTimersByTime(1000);
    // 触发关闭：先淡出，元素仍在
    expect(el.style.opacity).toBe('0');
    expect(el.isConnected).toBe(true);
    // 过渡时长（--motion-base 150ms，jsdom 读不到 token 走回退 150）后移除
    vi.advanceTimersByTime(150);
    expect(el.isConnected).toBe(false);
  });

  it('点击关闭同样走淡出；重复关闭幂等（不重复调度移除）', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    toast.info('点我关闭');
    const el = toasts()[0];
    el.click();
    expect(el.style.opacity).toBe('0');
    expect(el.isConnected).toBe(true);
    el.click(); // 第二次点击不再调度（data-closing 守卫）
    vi.advanceTimersByTime(150);
    expect(el.isConnected).toBe(false);
  });

  it('duration=0 常驻 toast：dismiss() 走淡出后移除', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    toast.warning('常驻', { duration: 0 });
    const el = toasts()[0];
    vi.advanceTimersByTime(5000);
    expect(el.isConnected).toBe(true); // 常驻不自动关
    toast.dismiss();
    expect(el.style.opacity).toBe('0');
    vi.advanceTimersByTime(150);
    expect(el.isConnected).toBe(false);
  });
});
