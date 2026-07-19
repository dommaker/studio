#!/usr/bin/env node
/**
 * E2E fake agent CLI — stands in for a real LLM CLI (claude/kimi) in
 * tests/e2e/mvp-loop.e2e.test.ts. Registered as provider `e2e-fake` via the
 * F4 override file ($STUDIO_HOME/.studio/providers.json).
 *
 * Contract with the real pipeline:
 *  - Spawn shape (agent-runner.executeLightweight, shell):
 *      cd <worktree> && node <this file> [--session <id>] < .daemon/prompt.md 2>&1
 *    (promptViaStdin: the prompt arrives on stdin; extra args are ignored)
 *  - Output shape: agent-runner parses stdout with parseStreamEvents() and
 *    extractResult(), which ONLY understand stream-json lines
 *    ({ "type": "result", "result": ... }). Plain stdout would yield empty
 *    text, so we emit one stream-json result line.
 *  - ACTION protocol: agent-loop.parseAgentOutput() scans the extracted text
 *    for `ACTION: PROGRESS|COMPLETE|NEED_INPUT:<summary>`.
 *
 * Behavior:
 *  - Prompt WITHOUT the F5 human-reply section (## 人类新回复) → NEED_INPUT
 *    with a deterministic question.
 *  - Prompt WITH ## 人类新回复 → COMPLETE with a deterministic result marker
 *    plus process.cwd(), so the test can verify the CLI ran inside the
 *    WorkUnit-bound workspace root (F6).
 *  - `--version` (health probe uses the node binary itself, so this is only
 *    a fallback) prints a version string.
 */

const RESULT_MARKER = 'E2E_RESULT_OK';
const QUESTION = '请确认：使用方案 A 还是方案 B？';

if (process.argv.includes('--version')) {
  console.log('e2e-fake-cli 0.0.1');
  process.exit(0);
}

let prompt = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const hasHumanReply = prompt.includes('## 人类新回复');
  const text = hasHumanReply
    ? `已收到人类回复，按回复继续并收尾。\nACTION: COMPLETE: ${RESULT_MARKER} 任务完成 (cwd=${process.cwd()})`
    : `分析完成，但缺少关键决策。\nACTION: NEED_INPUT: ${QUESTION}`;

  // stream-json: extractResult() reads the `result` field of type=result events
  const event = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: process.argv.includes('--session')
      ? process.argv[process.argv.indexOf('--session') + 1]
      : undefined,
  };
  process.stdout.write(JSON.stringify(event) + '\n');
});
