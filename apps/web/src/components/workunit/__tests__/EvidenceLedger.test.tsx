/**
 * EvidenceLedger tests — drawer/card 两变体的共享口径与差异呈现
 * 共享：层标签 / 行格式 `{kind} · {by 前 8 位} · {时间}` / 存量空态文案 / l2.summary 评审结论行
 * 差异：drawer = mc-kv + ✓/✗ 前缀；card = card 容器 + 通过/拒绝徽章
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EvidenceLedger } from '../EvidenceLedger';
import type { WuAttestations } from '@dommaker/studio-shared/web';

// l3 缺失（done 缺 l3 场景）；l2 带 summary
const baseAttestations: WuAttestations = {
  l1: { verdict: 'approved', by: 'profile-dev-1', at: '2026-07-19T10:50:00Z', kind: 'verify' },
  l2: { verdict: 'approved', by: '76d96d35-c35e', at: '2026-07-19T10:55:00Z', kind: 'agent-review', summary: '实现正确' },
};

describe('EvidenceLedger drawer 变体', () => {
  it('三层标签 + ✓/✗ 前缀行 + 评审结论；缺失层显示 —', () => {
    render(<EvidenceLedger attestations={baseAttestations} variant="drawer" />);
    expect(screen.getByText('证据台账')).toBeTruthy();
    expect(screen.getByText('自动验证')).toBeTruthy();
    expect(screen.getByText('Agent 评审')).toBeTruthy();
    expect(screen.getByText('人工确认')).toBeTruthy();
    expect(screen.getByText(/✓ verify · profile-/)).toBeTruthy();
    expect(screen.getByText(/✓ agent-review · 76d96d35/)).toBeTruthy();
    expect(screen.getByText('评审结论：实现正确')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('rejected  verdict 显示 ✗ 前缀', () => {
    render(
      <EvidenceLedger
        attestations={{ l1: { verdict: 'rejected', by: 'profile-dev-1', at: '2026-07-19T10:50:00Z', kind: 'verify' } }}
        variant="drawer"
      />
    );
    expect(screen.getByText(/✗ verify · profile-/)).toBeTruthy();
  });

  it('存量 WU（attestations undefined）显示未介入说明', () => {
    render(<EvidenceLedger attestations={undefined} variant="drawer" />);
    expect(screen.getByText('存量任务，证据模型未介入（按存储状态展示）')).toBeTruthy();
    expect(screen.queryByText('自动验证')).toBeNull();
  });
});

describe('EvidenceLedger card 变体', () => {
  it('三层标签 + 通过/拒绝徽章 + 评审结论；缺失层显示 —', () => {
    render(
      <EvidenceLedger
        attestations={{
          ...baseAttestations,
          l3: { verdict: 'rejected', by: 'human-admin', at: '2026-07-19T11:00:00Z', kind: 'human-confirm' },
        }}
        variant="card"
      />
    );
    expect(screen.getByText('证据台账')).toBeTruthy();
    expect(screen.getByText('自动验证')).toBeTruthy();
    expect(screen.getByText('Agent 评审')).toBeTruthy();
    expect(screen.getByText('人工确认')).toBeTruthy();
    expect(screen.getAllByText('✓ 通过').length).toBe(2);
    expect(screen.getByText('✗ 拒绝')).toBeTruthy();
    expect(screen.getByText(/agent-review · 76d96d35/)).toBeTruthy();
    expect(screen.getByText(/human-confirm · human-ad/)).toBeTruthy();
    expect(screen.getByText('评审结论：实现正确')).toBeTruthy();
  });

  it('存量 WU（attestations undefined）显示未介入说明', () => {
    render(<EvidenceLedger attestations={undefined} variant="card" />);
    expect(screen.getByText('存量任务，证据模型未介入（按存储状态展示）')).toBeTruthy();
    expect(screen.queryByText('自动验证')).toBeNull();
  });
});
