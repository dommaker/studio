/**
 * 分页单迭代器聚焦单测（#681 P1-1 五镜像收敛的新增纯函数）
 *
 * iteratePageCandidates（热新→旧接冷、锚点跳过、惰性）+ assembleMessagePage
 * （收集 limit+1 即停、一次切片出页、锚未命中空页）的等价分页语义：
 * 锚点/早停/hasMore/冷热边界。跨冷热同 id 去重不在本层（由冷流的 hotIds
 * 判据保证），此处只验迭代与切片契约。
 */

import { describe, it, expect } from 'vitest';
import { iteratePageCandidates, assembleMessagePage, type PageAnchorState } from '../file-store/file-store-messages-query';
import type { ChannelMessageData } from '../file-store/file-store-types';

function msg(id: string): ChannelMessageData {
  return {
    id,
    channelId: 'ch',
    workUnitId: null,
    authorType: 'human',
    agentName: null,
    content: id,
    replyToId: null,
    meta: '{}',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** 记录拉取次数的冷流（验证惰性：凑满即停，后续冷月不读） */
function trackedCold(ids: string[]): { stream: AsyncGenerator<ChannelMessageData>; pulled: () => number } {
  let pulled = 0;
  const stream = (async function* () {
    for (const id of ids) {
      pulled++;
      yield msg(id);
    }
  })();
  return { stream, pulled: () => pulled };
}

const HOT = ['h5', 'h4', 'h3', 'h2', 'h1'].map(msg); // 新→旧

describe('iteratePageCandidates + assembleMessagePage（#681 分页收敛）', () => {
  it('无锚点：热候选充足时一页 limit 条升序出页，hasMore=true，冷流不启动（惰性早停）', async () => {
    const cold = trackedCold(['c3', 'c2', 'c1']);
    const page = await assembleMessagePage(
      iteratePageCandidates(HOT, cold.stream, undefined, { found: true }), 3, 99);
    expect(page.messages.map(m => m.id)).toEqual(['h3', 'h4', 'h5']); // 收集序新→旧 → 出页升序
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(99); // total 由调用方三分支口径供给，装配层透传
    expect(cold.pulled()).toBe(0); // 热侧凑满 limit+1 → 冷流从未拉取
  });

  it('无锚点：热候选不足从冷补满（冷热边界：冷段落页首），多收 1 条判 hasMore', async () => {
    const cold = trackedCold(['c5', 'c4', 'c3', 'c2', 'c1']);
    const page = await assembleMessagePage(
      iteratePageCandidates(['h2', 'h1'].map(msg), cold.stream, undefined, { found: true }), 4, 0);
    expect(page.messages.map(m => m.id)).toEqual(['c4', 'c5', 'h1', 'h2']);
    expect(page.hasMore).toBe(true); // 收到第 5 条（c3）
    expect(cold.pulled()).toBe(3); // 凑满+多收 1 条即停，c2/c1 不读
  });

  it('无锚点：全链恰满 limit 时 hasMore=false', async () => {
    const cold = trackedCold(['c2', 'c1']);
    const page = await assembleMessagePage(
      iteratePageCandidates(['h2', 'h1'].map(msg), cold.stream, undefined, { found: true }), 4, 0);
    expect(page.messages.map(m => m.id)).toEqual(['c1', 'c2', 'h1', 'h2']);
    expect(page.hasMore).toBe(false);
  });

  it('锚点在热：跳过锚点及更新者（不含锚点），页 = 锚点起 limit 条', async () => {
    const cold = trackedCold(['c1']);
    const anchorState: PageAnchorState = { found: false };
    const page = await assembleMessagePage(
      iteratePageCandidates(HOT, cold.stream, 'h3', anchorState), 2, 0, anchorState);
    expect(anchorState.found).toBe(true);
    expect(page.messages.map(m => m.id)).toEqual(['h1', 'h2']);
    expect(page.hasMore).toBe(true); // 多收的 c1 判 hasMore（冷链整体更旧，探 1 条）
  });

  it('锚点在热且热侧余量超 limit：hasMore 恒真，冷流不启动', async () => {
    const cold = trackedCold(['c2', 'c1']);
    const anchorState: PageAnchorState = { found: false };
    const page = await assembleMessagePage(
      iteratePageCandidates(HOT, cold.stream, 'h5', anchorState), 2, 0, anchorState);
    expect(page.messages.map(m => m.id)).toEqual(['h3', 'h4']);
    expect(page.hasMore).toBe(true);
    expect(cold.pulled()).toBe(0);
  });

  it('锚点在冷：热段整体跳过（热恒比冷新），整页从冷出', async () => {
    const cold = trackedCold(['c5', 'c4', 'c3', 'c2', 'c1']);
    const anchorState: PageAnchorState = { found: false };
    const page = await assembleMessagePage(
      iteratePageCandidates(HOT, cold.stream, 'c4', anchorState), 2, 0, anchorState);
    expect(anchorState.found).toBe(true);
    expect(page.messages.map(m => m.id)).toEqual(['c2', 'c3']);
    expect(page.hasMore).toBe(true); // c1 多收判 hasMore
  });

  it('锚点不存在（冷热都没有）：空页 + hasMore=false（位置不可知不整页错发）', async () => {
    const cold = trackedCold(['c2', 'c1']);
    const anchorState: PageAnchorState = { found: false };
    const page = await assembleMessagePage(
      iteratePageCandidates(HOT, cold.stream, 'ghost', anchorState), 3, 42, anchorState);
    expect(page).toEqual({ messages: [], total: 42, hasMore: false });
  });

  it('锚点命中但无更旧消息：空页 + hasMore=false（found=true 的正常空页）', async () => {
    const cold = trackedCold([]);
    const anchorState: PageAnchorState = { found: false };
    const page = await assembleMessagePage(
      iteratePageCandidates(['h1'].map(msg), cold.stream, 'h1', anchorState), 3, 0, anchorState);
    expect(anchorState.found).toBe(true);
    expect(page).toEqual({ messages: [], total: 0, hasMore: false });
  });
});
