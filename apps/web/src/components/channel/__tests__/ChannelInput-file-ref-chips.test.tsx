// #485：composer 已挂文件引用 chip 可视化——引用台账（#281）从不可见变可见，
// 可单独移除；正文被编辑得不再包含路径时 chip 标灰提示（不再静默丢弃）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { mockListAgents, mockGetFileVocabulary } = vi.hoisted(() => ({
  mockListAgents: vi.fn(),
  mockGetFileVocabulary: vi.fn(),
}));

vi.mock('../../../api/channel', () => ({
  channelApi: {
    listAgents: mockListAgents,
    getFileVocabulary: mockGetFileVocabulary,
  },
}));

import { ChannelInput } from '../ChannelInput';
import { useRosterStore } from '../../../stores/rosterStore';
import { useChannelDataStore } from '../../../stores/channelDataStore';

const mockAgents = [
  { id: 'a1', name: 'dev-agent', description: null, status: 'active' },
];

const mockVocabulary = {
  repos: [
    { repo: '/repo/studio', files: ['src/index.ts'] },
    { repo: '/repo/web', files: ['src/main.ts'] },
  ],
};

function setup() {
  const onSend = vi.fn();
  const { container } = render(<ChannelInput onSend={onSend} sending={false} channelId="ch-1" />);
  const textarea = screen.getByPlaceholderText('输入消息，@Agent 提及 Agent...') as HTMLTextAreaElement;
  return { onSend, textarea, container };
}

function typeAt(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } });
}

async function insertFile(textarea: HTMLTextAreaElement, query: string, pathText: string) {
  typeAt(textarea, query);
  fireEvent.mouseDown((await screen.findByRole('option', { name: new RegExp(pathText.replace(/[/.]/g, m => `\\${m}`)) })));
}

describe('ChannelInput 文件引用 chip（#485）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAgents.mockResolvedValue({ data: { data: mockAgents } });
    mockGetFileVocabulary.mockResolvedValue({ data: { data: mockVocabulary } });
    useChannelDataStore.getState().__resetForTests();
    useRosterStore.setState({ profiles: mockAgents, loadedAt: Date.now(), inflight: null, forbidden: false, lastToken: null });
    useChannelDataStore.getState().setMembers('ch-1', []);
  });

  it('选中文件后 chip 展示（路径 + 所属工程 basename）', async () => {
    const { container, textarea } = setup();
    await insertFile(textarea, '@main.ts', 'src/main.ts');

    const chips = container.querySelector('.mc-fileref-chips');
    expect(chips).toBeTruthy();
    const chip = chips!.querySelector('.mc-fileref-chip')!;
    expect(chip.textContent).toContain('src/main.ts');
    expect(chip.textContent).toContain('web');
    // 初始为有效引用，不带失效标记
    expect(chip.classList.contains('mc-fileref-chip-invalid')).toBe(false);
  });

  it('chip 可单独移除：移除后发送不再携带该引用（即使正文仍含路径）', async () => {
    const { onSend, textarea } = setup();
    await insertFile(textarea, '@main.ts', 'src/main.ts');

    fireEvent.click(screen.getByRole('button', { name: '移除引用 src/main.ts' }));
    expect(document.querySelector('.mc-fileref-chip')).toBeNull();

    fireEvent.keyDown(textarea, { key: 'Enter' });
    // 引用已单独移除 → 保持无引用旧签名两参
    expect(onSend).toHaveBeenCalledWith('src/main.ts', undefined);
  });

  it('编辑正文使路径不再出现 → chip 标灰并可见「已失效」提示（非静默）', async () => {
    const { container, textarea } = setup();
    await insertFile(textarea, '@main.ts', 'src/main.ts');

    typeAt(textarea, '换个话题');
    const chip = container.querySelector('.mc-fileref-chip')!;
    expect(chip.classList.contains('mc-fileref-chip-invalid')).toBe(true);
    expect(chip.textContent).toContain('已失效');
  });

  it('失效引用的 chip 仍在台账可见，但发送时不上送（行为不变，仅透明化）', async () => {
    const { onSend, textarea, container } = setup();
    await insertFile(textarea, '@main.ts', 'src/main.ts');

    typeAt(textarea, '换个话题');
    expect(container.querySelector('.mc-fileref-chip')).toBeTruthy();

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('换个话题', undefined);
  });

  it('多引用混合：仅上送正文仍含路径的有效引用', async () => {
    const { onSend, textarea } = setup();
    await insertFile(textarea, '@main.ts', 'src/main.ts');
    typeAt(textarea, `${textarea.value}@index.ts`);
    fireEvent.mouseDown((await screen.findByRole('option', { name: /src\/index\.ts/ })));
    expect(textarea.value).toBe('src/main.ts src/index.ts ');

    // 只删掉第一个引用路径 → main.ts 失效，index.ts 有效
    typeAt(textarea, '看 src/index.ts');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('看 src/index.ts', undefined, [
      { repo: '/repo/studio', path: 'src/index.ts' },
    ]);
  });
});
