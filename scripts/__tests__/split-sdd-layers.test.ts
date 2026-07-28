import { describe, it, expect } from 'vitest';
import {
  splitH2Sections,
  extractJsonCodeBlock,
  extractDesignDataFromJson,
  extractContractTestsFromJson,
  formatArchitectureContext,
  formatContractTestsForTask,
  buildDesignBody,
  stripDesignSubsections,
  findJsonAcGroupsSection,
  findContractTestsSection,
  type AcGroupDesignData,
} from '../split-sdd-layers';

describe('splitH2Sections', () => {
  it('splits body into H2 sections', () => {
    const body = `## Section A
content A

## Section B
content B

## Section C
content C`;
    const sections = splitH2Sections(body);
    expect(sections).toHaveLength(3);
    expect(sections[0].title).toBe('Section A');
    expect(sections[0].content.trim()).toBe('content A');
    expect(sections[1].title).toBe('Section B');
    expect(sections[1].content.trim()).toBe('content B');
    expect(sections[2].title).toBe('Section C');
    expect(sections[2].content.trim()).toBe('content C');
  });

  it('handles body with no H2 sections', () => {
    const body = 'just some text\nno headers here';
    const sections = splitH2Sections(body);
    expect(sections).toHaveLength(0);
  });

  it('handles empty body', () => {
    expect(splitH2Sections('')).toHaveLength(0);
  });
});

describe('extractJsonCodeBlock', () => {
  it('extracts JSON from code block', () => {
    const text = 'some text\n```json\n[{"id": "g1"}]\n```\nmore text';
    expect(extractJsonCodeBlock(text)).toBe('[{"id": "g1"}]');
  });

  it('returns null when no code block', () => {
    expect(extractJsonCodeBlock('no code block here')).toBeNull();
  });

  it('handles multiline JSON', () => {
    const text = '```json\n[\n  {\n    "id": "g1",\n    "files": ["a.ts"]\n  }\n]\n```';
    const result = extractJsonCodeBlock(text);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('g1');
  });
});

describe('extractDesignDataFromJson', () => {
  it('extracts design data from AC groups JSON', () => {
    const json = JSON.stringify([
      {
        id: 'group-1',
        implementationNotes: 'Do this first',
        codePatterns: ['pattern-a', 'pattern-b'],
        gotchas: ['warning-1'],
        architectureContext: { functions: ['fnA'], callChain: 'A -> B' },
      },
    ]);
    const result = extractDesignDataFromJson(json);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('group-1');
    expect(result[0].implementationNotes).toBe('Do this first');
    expect(result[0].codePatterns).toEqual(['pattern-a', 'pattern-b']);
    expect(result[0].gotchas).toEqual(['warning-1']);
    expect(result[0].architectureContext).toBeTruthy();
  });

  it('handles missing fields gracefully', () => {
    const json = JSON.stringify([{ id: 'g1' }]);
    const result = extractDesignDataFromJson(json);
    expect(result).toHaveLength(1);
    expect(result[0].implementationNotes).toBe('');
    expect(result[0].codePatterns).toEqual([]);
    expect(result[0].gotchas).toEqual([]);
    expect(result[0].architectureContext).toBeNull();
  });

  it('returns empty on invalid JSON', () => {
    expect(extractDesignDataFromJson('not json')).toEqual([]);
  });

  it('returns empty on non-array', () => {
    expect(extractDesignDataFromJson('{"id": "g1"}')).toEqual([]);
  });
});

describe('extractContractTestsFromJson', () => {
  it('extracts contract tests', () => {
    const json = JSON.stringify([
      { file: '__tests__/foo.test.ts', content: 'test code here' },
      { file: '__tests__/bar.test.ts', content: 'more test code' },
    ]);
    const result = extractContractTestsFromJson(json);
    expect(result).toHaveLength(2);
    expect(result[0].file).toBe('__tests__/foo.test.ts');
    expect(result[0].content).toBe('test code here');
  });

  it('filters out entries without file or content', () => {
    const json = JSON.stringify([
      { file: '__tests__/ok.test.ts', content: 'ok' },
      { content: 'no file' },
      { file: 'no-content.ts' },
    ]);
    const result = extractContractTestsFromJson(json);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('__tests__/ok.test.ts');
  });

  it('returns empty on invalid JSON', () => {
    expect(extractContractTestsFromJson('not json')).toEqual([]);
  });
});

describe('formatArchitectureContext', () => {
  it('formats all fields', () => {
    const ctx = {
      functions: ['fnA()', 'fnB()'],
      callChain: 'A -> B -> C',
      imports: ['import x'],
      typesInScope: ['TypeA'],
      testMock: ['vi.mock("x")'],
      dangerZones: ['L10 do not touch'],
    };
    const result = formatArchitectureContext(ctx);
    expect(result).toContain('**Functions**');
    expect(result).toContain('- fnA()');
    expect(result).toContain('**Call Chain**');
    expect(result).toContain('A -> B -> C');
    expect(result).toContain('**Danger Zones**');
  });

  it('skips empty arrays', () => {
    const ctx = { functions: [], callChain: '', imports: [] };
    const result = formatArchitectureContext(ctx);
    expect(result).not.toContain('**Functions**');
    expect(result).not.toContain('**Call Chain**');
  });

  it('handles null/undefined fields', () => {
    const result = formatArchitectureContext({});
    expect(result).toBe('');
  });
});

describe('formatContractTestsForTask', () => {
  it('formats tests with code blocks', () => {
    const tests = [
      { file: '__tests__/a.test.ts', content: 'expect(1).toBe(1);' },
    ];
    const result = formatContractTestsForTask(tests);
    expect(result).toContain('## Contract Tests');
    expect(result).toContain('### __tests__/a.test.ts');
    expect(result).toContain('```typescript');
    expect(result).toContain('expect(1).toBe(1);');
  });

  it('returns empty for no tests', () => {
    expect(formatContractTestsForTask([])).toBe('');
  });
});

describe('buildDesignBody', () => {
  it('builds design body from groups', () => {
    const groups: AcGroupDesignData[] = [
      {
        id: 'g1',
        implementationNotes: 'Step 1: do X',
        codePatterns: ['ref: pattern-a'],
        gotchas: ['warn: watch out'],
        architectureContext: { functions: ['fn()'], callChain: 'x -> y', imports: [], typesInScope: [], testMock: [], dangerZones: [] },
      },
    ];
    const result = buildDesignBody(groups);
    expect(result).toContain('## Architecture Context');
    expect(result).toContain('## AC Groups');
    expect(result).toContain('### g1');
    expect(result).toContain('#### 实现指南');
    expect(result).toContain('Step 1: do X');
    expect(result).toContain('#### 参考模式');
    expect(result).toContain('- ref: pattern-a');
    expect(result).toContain('#### ⚠️ 注意事项');
    expect(result).toContain('- warn: watch out');
  });

  it('skips groups with no design content', () => {
    const groups: AcGroupDesignData[] = [
      {
        id: 'empty-group',
        implementationNotes: '',
        codePatterns: [],
        gotchas: [],
        architectureContext: null,
      },
    ];
    expect(buildDesignBody(groups)).toBe('');
  });

  it('omits Architecture Context when no groups have it', () => {
    const groups: AcGroupDesignData[] = [
      {
        id: 'g1',
        implementationNotes: 'notes',
        codePatterns: [],
        gotchas: [],
        architectureContext: null,
      },
    ];
    const result = buildDesignBody(groups);
    expect(result).not.toContain('## Architecture Context');
    expect(result).toContain('## AC Groups');
  });
});

describe('stripDesignSubsections', () => {
  it('removes 实现指南, 参考模式, 注意事项 subsections', () => {
    const content = `
### group-1
<!-- some html comment -->

#### 验收标准
- [ ] AC1: do something

#### 实现指南
Step 1: do this
Step 2: do that

#### 参考模式
- ref: some-pattern

#### ⚠️ 注意事项
- watch out for X

#### 涉及文件
- src/foo.ts
`;
    const result = stripDesignSubsections(content);
    expect(result).toContain('#### 验收标准');
    expect(result).toContain('AC1: do something');
    expect(result).toContain('#### 涉及文件');
    expect(result).toContain('src/foo.ts');
    expect(result).not.toContain('#### 实现指南');
    expect(result).not.toContain('Step 1: do this');
    expect(result).not.toContain('#### 参考模式');
    expect(result).not.toContain('ref: some-pattern');
    expect(result).not.toContain('#### ⚠️ 注意事项');
    expect(result).not.toContain('watch out for X');
  });

  it('handles content with no design subsections', () => {
    const content = `
### group-1

#### 验收标准
- [ ] AC1: do something

#### 涉及文件
- src/foo.ts
`;
    const result = stripDesignSubsections(content);
    expect(result).toContain('#### 验收标准');
    expect(result).toContain('#### 涉及文件');
  });

  it('preserves H3 boundaries correctly', () => {
    const content = `
### group-1

#### 验收标准
- [ ] AC1

#### 实现指南
notes for g1

### group-2

#### 验收标准
- [ ] AC2

#### 实现指南
notes for g2

#### 涉及文件
- src/bar.ts
`;
    const result = stripDesignSubsections(content);
    expect(result).toContain('### group-1');
    expect(result).toContain('### group-2');
    expect(result).toContain('#### 涉及文件');
    expect(result).not.toContain('notes for g1');
    expect(result).not.toContain('notes for g2');
  });
});

describe('findJsonAcGroupsSection', () => {
  it('finds the AC Groups section with JSON code block', () => {
    const sections = splitH2Sections(`## AC Groups

### group-1
some markdown

## AC Groups

\`\`\`json
[{"id": "g1"}]
\`\`\`

## Files`);
    const result = findJsonAcGroupsSection(sections);
    expect(result).toBeTruthy();
    expect(result!.content).toContain('```json');
  });

  it('returns null when no JSON AC Groups', () => {
    const sections = splitH2Sections(`## AC Groups

### group-1
some markdown`);
    expect(findJsonAcGroupsSection(sections)).toBeNull();
  });
});

describe('findContractTestsSection', () => {
  it('finds Contract Tests section', () => {
    const sections = splitH2Sections(`## Contract Tests

\`\`\`json
[{"file": "a.ts", "content": "code"}]
\`\`\``);
    const result = findContractTestsSection(sections);
    expect(result).toBeTruthy();
    expect(result!.title).toBe('Contract Tests');
  });

  it('returns null when no Contract Tests', () => {
    const sections = splitH2Sections(`## Files
- a.ts`);
    expect(findContractTestsSection(sections)).toBeNull();
  });
});
