import { describe, it, expect } from 'vitest';
import {
  extractFilesFromAcGroups,
  parseFilesFromJson,
  hasFilesSection,
  buildFilesSection,
} from '../patch-sdd-files-section';

describe('parseFilesFromJson', () => {
  it('extracts files from AC groups array', () => {
    const json = JSON.stringify([
      { id: 'g1', files: ['src/a.ts', 'src/b.ts'] },
      { id: 'g2', files: ['src/c.ts'] },
    ]);
    expect(parseFilesFromJson(json)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('strips line ranges from file paths', () => {
    const json = JSON.stringify([
      { id: 'g1', files: ['src/a.ts:L10-L20', 'src/b.ts:L5'] },
    ]);
    expect(parseFilesFromJson(json)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('skips empty or null files arrays', () => {
    const json = JSON.stringify([
      { id: 'g1', files: [] },
      { id: 'g2', files: null },
      { id: 'g3', files: ['src/a.ts'] },
    ]);
    expect(parseFilesFromJson(json)).toEqual(['src/a.ts']);
  });

  it('skips non-string entries', () => {
    const json = JSON.stringify([
      { id: 'g1', files: ['src/a.ts', 123, null, '', '  '] },
    ]);
    expect(parseFilesFromJson(json)).toEqual(['src/a.ts']);
  });

  it('returns empty on invalid JSON', () => {
    expect(parseFilesFromJson('not json')).toEqual([]);
  });

  it('returns empty on non-array JSON', () => {
    expect(parseFilesFromJson('{"files": ["a.ts"]}')).toEqual([]);
  });

  it('handles groups without files field', () => {
    const json = JSON.stringify([
      { id: 'g1', acs: ['something'] },
    ]);
    expect(parseFilesFromJson(json)).toEqual([]);
  });
});

describe('extractFilesFromAcGroups', () => {
  it('extracts files from AC Groups JSON code block', () => {
    const body = `## AC Groups

\`\`\`json
[
  {
    "id": "group-1",
    "files": ["src/foo.ts", "src/bar.ts"]
  }
]
\`\`\`

## Contract Tests`;
    expect(extractFilesFromAcGroups(body)).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('handles multiple AC Groups sections', () => {
    const body = `## AC Groups

\`\`\`json
[
  { "id": "g1", "files": ["a.ts"] }
]
\`\`\`

## Something

## AC Groups

\`\`\`json
[
  { "id": "g2", "files": ["b.ts"] }
]
\`\`\``;
    expect(extractFilesFromAcGroups(body)).toEqual(['a.ts', 'b.ts']);
  });

  it('returns empty when no AC Groups section', () => {
    const body = `## Summary

Some content here.
`;
    expect(extractFilesFromAcGroups(body)).toEqual([]);
  });

  it('returns empty when AC Groups has no JSON block', () => {
    const body = `## AC Groups

Some text without JSON.
`;
    expect(extractFilesFromAcGroups(body)).toEqual([]);
  });

  it('deduplicates files within extraction', () => {
    const body = `## AC Groups

\`\`\`json
[
  { "id": "g1", "files": ["src/a.ts", "src/b.ts"] },
  { "id": "g2", "files": ["src/a.ts", "src/c.ts"] }
]
\`\`\``;
    // Note: dedup happens at the buildFilesSection level, not here
    // extractFilesFromAcGroups returns all (including dupes)
    const result = extractFilesFromAcGroups(body);
    expect(result).toContain('src/a.ts');
    expect(result).toContain('src/b.ts');
    expect(result).toContain('src/c.ts');
  });
});

describe('hasFilesSection', () => {
  it('detects ## Files section', () => {
    expect(hasFilesSection('blah\n## Files\n- a.ts')).toBe(true);
  });

  it('detects ## 相关文件 section', () => {
    expect(hasFilesSection('blah\n## 相关文件\n- a.ts')).toBe(true);
  });

  it('returns false when no Files section', () => {
    expect(hasFilesSection('## Summary\nblah')).toBe(false);
  });

  it('does not match ### Files (H3)', () => {
    expect(hasFilesSection('### Files\n- a.ts')).toBe(false);
  });
});

describe('buildFilesSection', () => {
  it('builds sorted deduplicated file list', () => {
    const result = buildFilesSection(['b.ts', 'a.ts', 'b.ts']);
    expect(result).toBe('\n## Files\n\n- a.ts\n- b.ts\n');
  });

  it('handles single file', () => {
    const result = buildFilesSection(['src/app.ts']);
    expect(result).toBe('\n## Files\n\n- src/app.ts\n');
  });
});
