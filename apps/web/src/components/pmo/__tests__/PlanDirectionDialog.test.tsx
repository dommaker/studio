// PlanDirectionDialog — #567：方向锁定结构化选定表单（复用 #467/#463 范式：人只判断不录入）
// 推荐方向默认选中可改选；补充说明随提交注入；提交失败弹窗保持打开 + 内联错误；
// 「都不合适」= onCancel（关窗转自由文本回复，走通用复活路径）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PlanDirectionDialog, type PlanDirections } from '../PlanDirectionDialog';

const DIRECTIONS: PlanDirections = {
  question: '存储自研还是引入依赖？',
  options: [
    { name: '自研存储层', summary: '自控力强、无外部绑定', tradeoffs: '开发周期长两周', impact: '触及 storage 模块', recommended: true },
    { name: '引入 SQLite 库', summary: '快速落地、生态成熟', tradeoffs: '绑定上游版本节奏', impact: '新增一个依赖', recommended: false },
  ],
};

function setup(onSubmit = vi.fn(), onCancel = vi.fn()) {
  render(<PlanDirectionDialog directions={DIRECTIONS} onSubmit={onSubmit} onCancel={onCancel} />);
  return { onSubmit, onCancel };
}

describe('PlanDirectionDialog（#567 方向锁定表单）', () => {
  it('渲染：抉择点 + 候选卡（name/summary/tradeoffs/impact）+ 推荐徽标', () => {
    setup();
    expect(screen.getByText('存储自研还是引入依赖？')).toBeTruthy();
    expect(screen.getByText('自研存储层')).toBeTruthy();
    expect(screen.getByText(/自控力强/)).toBeTruthy();
    expect(screen.getByText(/开发周期长两周/)).toBeTruthy();
    expect(screen.getByText(/触及 storage 模块/)).toBeTruthy();
    expect(screen.getByText('引入 SQLite 库')).toBeTruthy();
    expect(screen.getByText('推荐')).toBeTruthy();
  });

  it('推荐方向默认选中，主键标签 = 「锁定推荐方向」', () => {
    setup();
    expect((screen.getByLabelText('方向：自研存储层') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: '锁定推荐方向' })).toBeTruthy();
  });

  it('改选非推荐项 → 主键标签切换为「锁定所选方向」，提交 choice = 改选方向名', async () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByLabelText('方向：引入 SQLite 库'));
    fireEvent.click(screen.getByRole('button', { name: '锁定所选方向' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ choice: '引入 SQLite 库' }));
  });

  it('补充说明随提交注入（note）；默认选中推荐项直接提交不带 note', async () => {
    const { onSubmit } = setup();
    fireEvent.change(screen.getByLabelText('补充说明'), { target: { value: ' 小需求走快道 ' } });
    fireEvent.click(screen.getByRole('button', { name: '锁定推荐方向' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ choice: '自研存储层', note: '小需求走快道' }));
  });

  it('提交失败：弹窗保持打开 + 内联错误文案', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('该任务无待选的方向'));
    setup(onSubmit);
    fireEvent.click(screen.getByRole('button', { name: '锁定推荐方向' }));
    expect(await screen.findByText('该任务无待选的方向')).toBeTruthy();
    expect(screen.getByRole('button', { name: '锁定推荐方向' })).toBeTruthy(); // 仍打开可重试
  });

  it('「都不合适」→ onCancel（关窗转自由文本回复），不触发提交', () => {
    const { onSubmit, onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: '都不合适' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
