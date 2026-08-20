// #285（决策 #249 §5）：inline-code 路径 token ↔ 文件词表「恰好唯一命中才染 chip」纪律
import { describe, it, expect } from 'vitest';
import type { ChannelFileVocabulary } from '../../api/channel';
import { matchFileRefToken, splitInlineCode, fileRefFullPath } from '../fileChipMatch';

const vocab: ChannelFileVocabulary = {
  repos: [
    { repo: '/repo/studio', files: ['src/index.ts', 'src/util.ts', 'docs/spec.md', '.studio/CONTEXT.md'] },
    { repo: '/repo/web', files: ['src/main.ts', 'src/util.ts'] },
  ],
};

describe('matchFileRefToken（#285 唯一命中纪律）', () => {
  it('精确全路径命中', () => {
    expect(matchFileRefToken('docs/spec.md', vocab)).toEqual({ repo: '/repo/studio', path: 'docs/spec.md' });
  });

  it('路径边界后缀命中（"/" + token 结尾）', () => {
    expect(matchFileRefToken('spec.md', vocab)).toEqual({ repo: '/repo/studio', path: 'docs/spec.md' });
    expect(matchFileRefToken('index.ts', vocab)).toEqual({ repo: '/repo/studio', path: 'src/index.ts' });
  });

  it('basename 唯一 → 命中', () => {
    expect(matchFileRefToken('main.ts', vocab)).toEqual({ repo: '/repo/web', path: 'src/main.ts' });
  });

  it('basename 不唯一 → null', () => {
    // util.ts 在两个仓都出现
    expect(matchFileRefToken('util.ts', vocab)).toBeNull();
  });

  it('跨仓重复路径 → null（全词表合并后非唯一）', () => {
    const dup: ChannelFileVocabulary = {
      repos: [
        { repo: '/repo/a', files: ['src/index.ts'] },
        { repo: '/repo/b', files: ['src/index.ts'] },
      ],
    };
    expect(matchFileRefToken('src/index.ts', dup)).toBeNull();
  });

  it('非路径边界的后缀不命中', () => {
    // 'rc/index.ts' 是 src/index.ts 的裸后缀，但前面不是 '/'
    expect(matchFileRefToken('rc/index.ts', vocab)).toBeNull();
  });

  it('无命中 → null', () => {
    expect(matchFileRefToken('no/such/file.ts', vocab)).toBeNull();
  });

  it('空/非法 token → null', () => {
    expect(matchFileRefToken('', vocab)).toBeNull();
    expect(matchFileRefToken('   ', vocab)).toBeNull();
    expect(matchFileRefToken('src/\nindex.ts', vocab)).toBeNull();
  });

  it('token 首尾空白先 trim 再匹配', () => {
    expect(matchFileRefToken('  src/index.ts  ', vocab)).toEqual({ repo: '/repo/studio', path: 'src/index.ts' });
  });
});

describe('matchFileRefToken · WU 产出/修改文件集优先层（#285 AC4，决策 #249 §5）', () => {
  const wuFiles = ['/wt/exec-1/src/index.ts', '/wt/exec-1/docs/wu-only.md'];

  it('WU 文件集唯一命中 → 优先于候选集词表染 chip（FileRef 从绝对路径切出）', () => {
    // 'docs/wu-only.md' 不在候选集词表：词表层本来染不了，WU 层唯一命中 → 染
    expect(matchFileRefToken('docs/wu-only.md', vocab, wuFiles))
      .toEqual({ repo: '/wt/exec-1', path: 'docs/wu-only.md' });
    // 绝对路径全写同样命中（token === 绝对路径 → repo 取目录、path 取 basename，
    // fileRefFullPath 重组后仍是同一绝对路径）
    expect(matchFileRefToken('/wt/exec-1/docs/wu-only.md', vocab, wuFiles))
      .toEqual({ repo: '/wt/exec-1/docs', path: 'wu-only.md' });
  });

  it('WU 文件集与词表都能命中时 WU 层优先', () => {
    // 'src/index.ts' 词表唯一命中 /repo/studio；WU 层也唯一命中 → 取 WU 层
    expect(matchFileRefToken('src/index.ts', vocab, wuFiles))
      .toEqual({ repo: '/wt/exec-1', path: 'src/index.ts' });
  });

  it('WU 文件集歧义（多条命中）→ null，不回退词表（同一匹配纪律：歧义保持纯文本）', () => {
    const ambiguous = ['/wt/exec-1/src/util.ts', '/wt/exec-1/lib/util.ts'];
    expect(matchFileRefToken('util.ts', vocab, ambiguous)).toBeNull();
  });

  it('WU 文件集无命中 → 降级候选集词表', () => {
    expect(matchFileRefToken('main.ts', vocab, wuFiles))
      .toEqual({ repo: '/repo/web', path: 'src/main.ts' });
  });

  it('WU 文件集为空/未传 → 行为与单词表一致', () => {
    expect(matchFileRefToken('index.ts', vocab, [])).toEqual({ repo: '/repo/studio', path: 'src/index.ts' });
    expect(matchFileRefToken('index.ts', vocab)).toEqual({ repo: '/repo/studio', path: 'src/index.ts' });
  });
});

describe('splitInlineCode', () => {
  it('按 `...` 切分 text/code 段', () => {
    expect(splitInlineCode('看 `src/index.ts` 和 `main.ts` 结尾')).toEqual([
      { type: 'text', text: '看 ' },
      { type: 'code', text: 'src/index.ts' },
      { type: 'text', text: ' 和 ' },
      { type: 'code', text: 'main.ts' },
      { type: 'text', text: ' 结尾' },
    ]);
  });

  it('不成对的反引号保持原文 text', () => {
    expect(splitInlineCode('a `x` b `unclosed')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'code', text: 'x' },
      { type: 'text', text: ' b `unclosed' },
    ]);
  });

  it('无 inline-code → 单 text 段', () => {
    expect(splitInlineCode('纯文本')).toEqual([{ type: 'text', text: '纯文本' }]);
  });
});

describe('fileRefFullPath', () => {
  it('repo + path 拼接防双斜杠', () => {
    expect(fileRefFullPath({ repo: '/repo/studio', path: 'src/index.ts' })).toBe('/repo/studio/src/index.ts');
    expect(fileRefFullPath({ repo: '/repo/studio/', path: 'src/index.ts' })).toBe('/repo/studio/src/index.ts');
  });
});
