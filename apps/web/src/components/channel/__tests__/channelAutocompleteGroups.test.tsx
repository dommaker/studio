// channelAutocompleteGroups（#691）：@/# 弹框候选分组构建器——过滤口径
// （agent includes / 文件路径后缀 + 封顶 / PMO includes + fail-closed）、
// insertText 形态（@name·path·#PMO-n 带尾随空格）、onPicked 台账回调、repoBasename。
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { AgentProfile, ChannelPmoCandidate } from '../../../api/channel';
import { buildMentionGroups, buildPmoGroups, repoBasename } from '../channelAutocompleteGroups';

const agent = (id: string, name: string, description: string | null = null): AgentProfile =>
  ({ id, name, description, status: 'active' }) as AgentProfile;

const pmo = (id: string, pmoNumber: string, title: string): ChannelPmoCandidate =>
  ({ id, pmoNumber, title }) as ChannelPmoCandidate;

const vocab = [{ repo: '/abs/repo-a', files: ['src/App.tsx', 'src/appUtils.ts', 'README.md'] }];

describe('buildMentionGroups', () => {
  it('Agents 组 = 名称小写 includes 过滤；insertText = `@name `', () => {
    const groups = buildMentionGroups({
      query: 'dev', agents: [agent('a1', 'dev-agent'), agent('a2', 'pm-agent')],
      vocabRepos: undefined, onFileRef: vi.fn(),
    });
    expect(groups[0].label).toBe('Agents');
    expect(groups[0].items.map(i => i.key)).toEqual(['a1']);
    expect(groups[0].items[0].insertText).toBe('@dev-agent ');
  });

  it('Files 组 = 词表路径后缀精确匹配；insertText = `path `（不带 @）；onPicked 回调带结构化引用', () => {
    const onFileRef = vi.fn();
    const groups = buildMentionGroups({ query: 'app.tsx', agents: [], vocabRepos: vocab, onFileRef });
    expect(groups[1].items.map(i => i.key)).toEqual(['/abs/repo-a:src/App.tsx']);
    expect(groups[1].items[0].insertText).toBe('src/App.tsx ');
    groups[1].items[0].onPicked?.();
    expect(onFileRef).toHaveBeenCalledWith({ repo: '/abs/repo-a', path: 'src/App.tsx' });
  });

  it('空 query 不献文件候选（防全量刷屏）；词表缺键 → 无文件候选', () => {
    const empty = buildMentionGroups({ query: '', agents: [agent('a1', 'dev')], vocabRepos: vocab, onFileRef: vi.fn() });
    expect(empty[1].items).toEqual([]);
    const missing = buildMentionGroups({ query: 'app', agents: [], vocabRepos: undefined, onFileRef: vi.fn() });
    expect(missing[1].items).toEqual([]);
  });

  it('文件候选 20 条封顶', () => {
    const many = [{ repo: '/r', files: Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`) }];
    const groups = buildMentionGroups({ query: '.ts', agents: [], vocabRepos: many, onFileRef: vi.fn() });
    expect(groups[1].items.length).toBe(20);
  });

  it('renderItem：agent 行带 @名与描述；文件行带路径与 repo basename', () => {
    const groups = buildMentionGroups({
      query: '', agents: [agent('a1', 'dev-agent', '写代码')], vocabRepos: vocab, onFileRef: vi.fn(),
    });
    const { container: c1 } = render(<>{groups[0].renderItem(groups[0].items[0])}</>);
    expect(c1.textContent).toContain('@dev-agent');
    expect(c1.textContent).toContain('写代码');
    const withFiles = buildMentionGroups({ query: 'app.tsx', agents: [], vocabRepos: vocab, onFileRef: vi.fn() });
    const { container: c2 } = render(<>{withFiles[1].renderItem(withFiles[1].items[0])}</>);
    expect(c2.textContent).toContain('src/App.tsx');
    expect(c2.textContent).toContain('repo-a');
  });
});

describe('buildPmoGroups', () => {
  const candidates = [pmo('p1', 'PMO-1', '发布管线'), pmo('p2', 'PMO-2', '前端收口')];

  it('query 小写 includes 匹配 pmoNumber 或 title；insertText = `#PMO-n `', () => {
    const groups = buildPmoGroups({ query: '发布', pmoCandidates: candidates, currentPmo: null });
    expect(groups[0].items.map(i => i.key)).toEqual(['p1']);
    expect(groups[0].items[0].insertText).toBe('#PMO-1 ');
    const byNumber = buildPmoGroups({ query: 'pmo-2', pmoCandidates: candidates, currentPmo: null });
    expect(byNumber[0].items.map(i => i.key)).toEqual(['p2']);
  });

  it('缺键（undefined）/ 空数组 → 无候选（fail-closed）', () => {
    expect(buildPmoGroups({ query: '', pmoCandidates: undefined, currentPmo: null })[0].items).toEqual([]);
    expect(buildPmoGroups({ query: 'zzz', pmoCandidates: candidates, currentPmo: null })[0].items).toEqual([]);
  });

  it('renderItem：命中当前 PMO 的候选带「当前」标记', () => {
    const groups = buildPmoGroups({ query: '', pmoCandidates: candidates, currentPmo: pmo('p2', 'PMO-2', '前端收口') });
    const { container: c1 } = render(<>{groups[0].renderItem(groups[0].items[0])}</>);
    expect(c1.textContent).toContain('#PMO-1 · 发布管线');
    expect(c1.textContent).not.toContain('当前');
    const { container: c2 } = render(<>{groups[0].renderItem(groups[0].items[1])}</>);
    expect(c2.textContent).toContain('当前');
  });
});

describe('repoBasename', () => {
  it('绝对路径取末段；无斜杠原样返回', () => {
    expect(repoBasename('/abs/path/repo-a')).toBe('repo-a');
    expect(repoBasename('/abs/path/repo-a/')).toBe('repo-a');
    expect(repoBasename('repo-b')).toBe('repo-b');
  });
});
