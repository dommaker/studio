import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const API_SRC = path.resolve(__dirname, '../../..');

const consumers = [
  { file: 'modules/agent-loop/prompt-composer.ts', call: 'knowledgePorts.consume.injectContext' },
  { file: 'modules/agent-loop/loop/loop-record-result.ts', call: 'knowledgePorts.produce.extractFromExecution' },
  { file: 'modules/agent-loop/loop/loop-step.ts', call: 'knowledgePorts.track.recordOutcome' },
  { file: 'modules/knowledge/review-adapter.ts', call: 'knowledgePorts.lifecycle.promote' },
  { file: 'modules/knowledge/review-adapter.ts', call: 'knowledgePorts.lifecycle.demote' },
  { file: 'modules/triage/triage.service.ts', call: 'knowledgePorts.resolve.createResolution' },
  { file: 'modules/agent-auditor/auditor-rules.ts', call: 'knowledgePorts.measure.getStats' },
];

describe('Knowledge 六能力真实生产消费（ARCH-06）', () => {
  it.each(consumers)('$file 经 $call 消费窄口', ({ file, call }) => {
    const source = fs.readFileSync(path.join(API_SRC, file), 'utf8');
    expect(source).toContain(call);
    expect(source).not.toMatch(/import\s*\{\s*knowledgeService\s*\}/);
  });
});
