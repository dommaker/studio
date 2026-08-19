// #281（决策 #249 §5）：@弹框统一分组（上 agents 下 files）+ 文件路径补全 +
// 发送携带结构化 files=[{repo, path}]（mention 文本不动，文件插入为纯路径文本）。
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

const mockAgents = [
  { id: 'a1', name: 'dev-agent', description: null, status: 'active' },
  { id: 'a2', name: 'ts-helper', description: null, status: 'active' },
];

const mockVocabulary = {
  repos: [
    { repo: '/repo/studio', files: ['src/index.ts', 'src/app.ts', 'docs/spec.md', 'bin/dev-agent'] },
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

const popupOpen = (container: HTMLElement) => !!container.querySelector('.mc-mention-popup');

describe('ChannelInput @文件引用（#281）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAgents.mockResolvedValue({ data: { data: mockAgents } });
    mockGetFileVocabulary.mockResolvedValue({ data: { data: mockVocabulary } });
  });

  it('拉取频道词表；弹框分组展示：上 Agents 下 Files，文件按路径后缀补全', async () => {
    const { textarea } = setup();
    await vi.waitFor(() => expect(mockGetFileVocabulary).toHaveBeenCalledWith('ch-1'));

    typeAt(textarea, '@ts');
    // 分组标题齐全
    expect(await screen.findByText('Agents')).toBeTruthy();
    expect(screen.getByText('Files')).toBeTruthy();
    // 后缀补全：命中 ts 结尾的三条，.md 不出现
    expect(screen.getByText('src/index.ts')).toBeTruthy();
    expect(screen.getByText('src/app.ts')).toBeTruthy();
    expect(screen.getByText('src/main.ts')).toBeTruthy();
    expect(screen.queryByText('docs/spec.md')).toBeNull();

    // Agents 组在 Files 组之前（DOM 序）
    const agentsHeader = await screen.findByText('Agents');
    const filesHeader = screen.getByText('Files');
    expect(agentsHeader.compareDocumentPosition(filesHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('文件候选展示所属工程（basename）；点击插入纯路径文本（不带 @）并关闭弹层', async () => {
    const { textarea, container } = setup();
    typeAt(textarea, '@main.ts');
    const item = await screen.findByText('src/main.ts');
    // 同条目内展示工程 basename 供多仓消歧
    expect(item.closest('button')!.textContent).toContain('web');

    fireEvent.mouseDown(item.closest('button')!);
    expect(textarea.value).toBe('src/main.ts ');
    expect(popupOpen(container)).toBe(false);
  });

  it('选中文件后发送：onSend 携带结构化 files=[{repo, path}]；无引用时不传第三参', async () => {
    const { onSend, textarea } = setup();
    typeAt(textarea, '看 @main.ts');
    fireEvent.mouseDown((await screen.findByText('src/main.ts')).closest('button')!);

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('看 src/main.ts', undefined, [
      { repo: '/repo/web', path: 'src/main.ts' },
    ]);

    // 无引用消息：保持旧签名两参
    typeAt(textarea, 'plain');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenLastCalledWith('plain', undefined);
  });

  it('发送前删掉引用文本 → 该引用不随消息发出（防陈旧引用）', async () => {
    const { onSend, textarea } = setup();
    typeAt(textarea, '@main.ts');
    fireEvent.mouseDown((await screen.findByText('src/main.ts')).closest('button')!);
    expect(textarea.value).toBe('src/main.ts ');

    typeAt(textarea, '换个话题');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('换个话题', undefined);
  });

  it('键盘导航跨组：ArrowDown 从 agent 组进入 file 组，Enter 插入文件路径', async () => {
    const { textarea } = setup();
    // 'dev-agent' 同时命中 agent（子串）与文件 bin/dev-agent（后缀）
    typeAt(textarea, '@dev-agent');
    await screen.findByText('@dev-agent');
    await screen.findByText('bin/dev-agent');

    fireEvent.keyDown(textarea, { key: 'ArrowDown' }); // agent 组 → file 组
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('bin/dev-agent ');
  });

  it('Esc 关闭分组弹框（#270 dismiss 语义延伸到 files 组）', async () => {
    const { textarea, container } = setup();
    typeAt(textarea, '@index.ts');
    await screen.findByText('src/index.ts');
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(popupOpen(container)).toBe(false);
  });
});
