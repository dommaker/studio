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
 *  - COMPLETE 路径同步真实 CLI 契约：在 cwd 写出 hello.js 并 git commit ——
 *    收口闸 1（completion-gates，base..HEAD 无提交 → 降级）与 §10.5 提交守卫
 *    （工作区脏 → 降级）都以真实 git 状态为准，零产出 fake 永远走不到
 *    in_review。只 add 自己写的产物文件（不 add -A），工具产物是否被
 *    exclude 仍由提交守卫真实检验。非 git 工作区 commit 失败不阻断输出。
 *  - `--version` (health probe uses the node binary itself, so this is only
 *    a fallback) prints a version string.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

  if (hasHumanReply) {
    // 真实 agent 会产出代码并提交；fake 写一个 hello 实现并 commit（身份内联，
    // 不依赖仓配置）。重复 COMPLETE（守卫打回后重试）时文件无变化、commit 失败，
    // 吞掉即可——此时 base..HEAD 已有首次提交。
    try {
      writeFileSync(
        join(process.cwd(), 'hello.js'),
        'export function hello(name) {\n  return `hello, ${name}`;\n}\n',
      );
      execFileSync('git', ['add', 'hello.js'], { cwd: process.cwd(), stdio: 'pipe' });
      execFileSync('git', [
        '-c', 'user.email=e2e-fake@studio.local', '-c', 'user.name=e2e-fake',
        'commit', '-q', '-m', 'e2e fake: implement hello',
      ], { cwd: process.cwd(), stdio: 'pipe' });
    } catch { /* 非 git 工作区或无新变化：不阻断结果输出 */ }
  }

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
