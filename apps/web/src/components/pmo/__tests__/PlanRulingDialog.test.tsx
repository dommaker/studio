// PlanRulingDialog — #467：裁决轮结构化评审表单（复用 #463 范式：人只判断不录入）
// 每题结论预填 agent 建议（可改 = 单题修改）；每题可勾「打回重议」（只重调该题）；
// 「全部采纳」= 全对一键（零编辑按建议结论提交）；提交失败弹窗保持打开 + 内联错误。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PlanRulingDialog } from '../PlanRulingDialog';

const RULINGS = [
  { question: '存储选型？', suggestion: 'SQLite', default: '单机默认 SQLite' },
  { question: '部署形态？', suggestion: '单机' },
];

function setup(onSubmit = vi.fn()) {
  render(<PlanRulingDialog rulings={RULINGS} onSubmit={onSubmit} onCancel={vi.fn()} />);
  return onSubmit;
}

describe('PlanRulingDialog（#467 裁决轮表单）', () => {
  it('预填：每题结论输入框默认 = agent 建议结论；默认值提示展示', () => {
    setup();
    expect((screen.getByLabelText('结论 1') as HTMLTextAreaElement).value).toBe('SQLite');
    expect((screen.getByLabelText('结论 2') as HTMLTextAreaElement).value).toBe('单机');
    expect(screen.getByText(/单机默认 SQLite/)).toBeTruthy();
    expect(screen.getByText('存储选型？')).toBeTruthy();
  });

  it('单题修改：编辑结论后「提交裁决」用改后文本', async () => {
    const onSubmit = setup();
    fireEvent.change(screen.getByLabelText('结论 1'), { target: { value: '改判：用 Postgres' } });
    fireEvent.click(screen.getByRole('button', { name: '提交裁决' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([
      { question: '存储选型？', action: 'accept', conclusion: '改判：用 Postgres' },
      { question: '部署形态？', action: 'accept', conclusion: '单机' },
    ]));
  });

  it('某题打回重议：勾选后结论输入禁用，提交该题 action=reopen（无 conclusion）', async () => {
    const onSubmit = setup();
    fireEvent.click(screen.getByLabelText('打回重议 2'));
    expect((screen.getByLabelText('结论 2') as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '提交裁决' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([
      { question: '存储选型？', action: 'accept', conclusion: 'SQLite' },
      { question: '部署形态？', action: 'reopen' },
    ]));
  });

  it('全部采纳：即便编辑过结论，也按 agent 建议结论一键提交（全对）', async () => {
    const onSubmit = setup();
    fireEvent.change(screen.getByLabelText('结论 1'), { target: { value: '随手改的' } });
    fireEvent.click(screen.getByRole('button', { name: '全部采纳' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([
      { question: '存储选型？', action: 'accept', conclusion: 'SQLite' },
      { question: '部署形态？', action: 'accept', conclusion: '单机' },
    ]));
  });

  it('提交失败：弹窗保持打开 + 内联错误文案', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('载荷非法'));
    setup(onSubmit);
    fireEvent.click(screen.getByRole('button', { name: '提交裁决' }));
    expect(await screen.findByText('载荷非法')).toBeTruthy();
    expect(screen.getByRole('button', { name: '提交裁决' })).toBeTruthy(); // 仍打开可重试
  });
});
