// ChannelStageBar（#440 Phase 2）— 频道详情页顶部阶段条：复用 buildLifecycle + StationStepper，
// 阶段语义 = deriveDisplayState 展示列（与 WU 详情页同口径，不发明第二套阶段模型）。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChannelStageBar } from '../ChannelStageBar';
import type { WorkUnit } from '../../../api/workunit';

const wu = (over: Partial<WorkUnit>): WorkUnit => ({
  id: 'WU-1', parentId: null, dependsOn: '', type: 'task', scope: 's',
  assigneeId: null, status: 'active', failureType: null, retryCount: 0,
  timeoutAt: null, channelId: 'ch-1', metadata: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T01:00:00Z',
  claimedAt: '2026-09-01T00:30:00Z', completedAt: null,
  ...over,
});

const stationEls = (container: HTMLElement) => [...container.querySelectorAll('.wu-bstep')];

describe('ChannelStageBar', () => {
  it('无当前 WU → 不渲染', () => {
    const { container } = render(<ChannelStageBar wu={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('active WU → 四站渲染，当前站 = 进行中，前站 done、后站 upcoming', () => {
    const { container } = render(<ChannelStageBar wu={wu({ status: 'active' })} />);
    const steps = stationEls(container);
    expect(steps).toHaveLength(4);
    expect(steps.map(el => el.querySelector('.wu-st-label')!.textContent))
      .toEqual(['待领取', '进行中', '待验收', '完成']);
    expect(steps[0].className).toContain('wu-st-done');
    expect(steps[1].className).toContain('wu-st-current');
    expect(steps[2].className).toContain('wu-st-upcoming');
    expect(steps[3].className).toContain('wu-st-upcoming');
  });

  it('in_review WU → 当前站 = 待验收（三态可区分）', () => {
    const { container } = render(<ChannelStageBar wu={wu({ status: 'in_review' })} />);
    const steps = stationEls(container);
    expect(steps[2].className).toContain('wu-st-current');
    expect(steps[0].className).toContain('wu-st-done');
    expect(steps[3].className).toContain('wu-st-upcoming');
  });

  it('done WU（无证据 legacy）→ 四站全 done', () => {
    const { container } = render(<ChannelStageBar wu={wu({ status: 'done', completedAt: '2026-09-01T02:00:00Z' })} />);
    const steps = stationEls(container);
    expect(steps.every(el => el.className.includes('wu-st-done'))).toBe(true);
  });

  it('阶段语义与 deriveDisplayState 同口径：done 缺 l3 → 当前站回待验收', () => {
    const metadata = JSON.stringify({
      attestations: { l2: { verdict: 'approved', by: 'rev', at: '2026-09-01T01:30:00Z', kind: 'agent-review' } },
    });
    render(<ChannelStageBar wu={wu({ status: 'done', metadata })} />);
    // 展示列回 in_review → 「待验收」为当前站
    const bar = screen.getByLabelText('工单阶段');
    const steps = [...bar.querySelectorAll('.wu-bstep')];
    expect(steps[2].className).toContain('wu-st-current');
    expect(steps[3].className).toContain('wu-st-upcoming');
  });
});
