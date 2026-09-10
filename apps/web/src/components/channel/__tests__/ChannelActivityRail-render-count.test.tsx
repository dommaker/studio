// #416 ChannelActivityRail 渲染边界 render-count 测试：
// ① 整栏 memo——props 全稳定（无关 message_sent 场景）时整栏零重渲；
// ② 卡内静态边界——相关动态到达（messageItems 新增条目）时动态行正常更新，
//    静态部分（卡头/stepper/meta，以 deriveChainSteps 调用计数为探针）零重渲。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import type { ReactNode } from 'react';

const { mockGetChain, mockGetCurrentPmo, mockProjectGet, mockResolveAssignee, mockNavigate, stepsCount, buildCount } = vi.hoisted(() => ({
  mockGetChain: vi.fn(),
  mockGetCurrentPmo: vi.fn(),
  mockProjectGet: vi.fn(),
  mockResolveAssignee: vi.fn(),
  mockNavigate: vi.fn(),
  stepsCount: { n: 0 },
  buildCount: { n: 0 },
}));

vi.mock('../../../api/requirements', () => ({ requirementApi: { getChain: mockGetChain } }));
vi.mock('../../../api/channel', () => ({ channelApi: { getCurrentPmo: mockGetCurrentPmo } }));
vi.mock('../../../api', () => ({ projectApi: { get: mockProjectGet } }));
vi.mock('../../../hooks/useAssigneeDisplay', () => ({ resolveAssignee: mockResolveAssignee }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

// 探针：deriveChainSteps（卡静态部分每次渲染必调）与 buildChannelActivity（动态派生入口）计数，
// 实现本体放行（importOriginal 部分 mock，行为不变）
vi.mock('../activityRail', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../activityRail')>();
  return {
    ...mod,
    deriveChainSteps: (...args: Parameters<typeof mod.deriveChainSteps>) => {
      stepsCount.n++;
      return mod.deriveChainSteps(...args);
    },
    buildChannelActivity: (input: Parameters<typeof mod.buildChannelActivity>[0]) => {
      buildCount.n++;
      return mod.buildChannelActivity(input);
    },
  };
});

import { ChannelActivityRail } from '../ChannelActivityRail';
import { useChannelDataStore } from '../../../stores/channelDataStore';
import { useRequirementChainStore } from '../../../stores/requirementChainStore';
import type { Requirement } from '../../../api/requirements';
import type { ChannelActivityItem } from '../activityRail';

function req(id: string): Requirement {
  return {
    id, seq: 1, title: `标题${id}`, status: 'in-progress',
    createdAt: '2026-08-01T00:00:00Z', createdBy: 'human',
  };
}

function wuItem(id: string, wuId: string, at: string): ChannelActivityItem {
  return { id, kind: 'wu', text: `动态${id}`, at, wuId };
}

function makeProps(messageItems: ChannelActivityItem[]) {
  return {
    channelId: 'ch1',
    reqs: [req('REQ-0001')],
    messageItems,
    waitingWus: [],
    onOpenWu: vi.fn(),
    onOpenReq: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stepsCount.n = 0;
  buildCount.n = 0;
  useChannelDataStore.getState().__resetForTests();
  useRequirementChainStore.getState().__resetForTests();
  mockResolveAssignee.mockResolvedValue(null);
  mockGetChain.mockResolvedValue({
    data: {
      data: {
        requirement: { projectId: null },
        workunits: [
          { id: 'wu-a', title: '任务wu-a', status: 'done', assigneeId: null },
          { id: 'wu-b', title: '任务wu-b', status: 'active', assigneeId: null },
        ],
      },
    },
  });
  mockGetCurrentPmo.mockResolvedValue({ data: { data: null } });
});

describe('ChannelActivityRail — #416 渲染边界', () => {
  it('props 全稳定（无关 message_sent 场景）→ 整栏 memo 零重渲', async () => {
    const props = makeProps([wuItem('m1', 'wu-a', '2026-08-10T00:00:00Z')]);
    const view = render(<ChannelActivityRail {...props} />);
    const card = (await screen.findByText('REQ-0001')).closest('.mc-act-card') as HTMLElement;
    await within(card).findByText('任务 1/2'); // chain 到位、stepper 已渲染
    await act(async () => {}); // flush 残余微任务（label/assignee 拉取）
    const stepsAfterMount = stepsCount.n;
    const buildAfterMount = buildCount.n;
    expect(stepsAfterMount).toBeGreaterThan(0);

    // 同一组 props 引用重渲染（= 无关 message_sent 后页面重渲、投影引用不变的场景）
    view.rerender(<ChannelActivityRail {...props} />);
    expect(stepsCount.n).toBe(stepsAfterMount);
    expect(buildCount.n).toBe(buildAfterMount);
  });

  it('相关动态到达（messageItems 新增条目）→ 动态行更新，静态部分零重渲（ticket AC）', async () => {
    const base = [wuItem('m1', 'wu-a', '2026-08-10T00:00:00Z')];
    const props = makeProps(base);
    const view = render(<ChannelActivityRail {...props} />);
    const card = (await screen.findByText('REQ-0001')).closest('.mc-act-card') as HTMLElement;
    await within(card).findByText('任务 1/2');
    await within(card).findByText('动态m1');
    await act(async () => {});
    const stepsAfterMount = stepsCount.n;

    // message_sent 携带右栏相关动态：投影新增一条（引用必变），其余 props 引用不动
    view.rerender(
      <ChannelActivityRail
        {...props}
        messageItems={[...base, wuItem('m2', 'wu-a', '2026-08-10T00:01:00Z')]}
      />,
    );

    // 动态区更新：新条目落卡下最近动态
    expect(await within(card).findByText('动态m2')).toBeTruthy();
    // 静态部分（卡头/四站 stepper/PMO·Agent meta）零重渲
    expect(stepsCount.n).toBe(stepsAfterMount);
    expect(within(card).getByText('任务 1/2')).toBeTruthy();
  });
});
