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

function streamResult(result, sessionId, isError = false) {
  if (sessionId && !isError) {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n');
  }
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: isError ? 'error' : 'success',
    is_error: isError,
    result,
    session_id: sessionId,
  }) + '\n');
}

function commitMultiRepoImplementation(task) {
  writeFileSync(
    join(process.cwd(), 'hello.js'),
    `export function hello(name) {\n  return \`hello, \${name}\`;\n}\n`,
  );
  writeFileSync(
    join(process.cwd(), 'hello.test.js'),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { hello } from './hello.js';\ntest('hello', () => assert.equal(hello('Studio'), 'hello, Studio'));\n",
  );
  execFileSync('git', ['add', 'hello.js', 'hello.test.js'], { cwd: process.cwd(), stdio: 'pipe' });
  execFileSync('git', [
    '-c', 'user.email=e2e-fake@studio.local', '-c', 'user.name=e2e-fake',
    'commit', '-q', '-m', `e2e fake: implement ${task}`,
  ], { cwd: process.cwd(), stdio: 'pipe' });
}

/** #723 专用协议；不匹配时返回 false，保留上方 MVP fake 的原始行为。 */
function runMultiRepoFlow() {
  const isMultiRepo = prompt.includes('E2E_MULTI_REPO') || prompt.includes('E2E_TASK_A') || prompt.includes('E2E_TASK_B');
  const isKnowledgeExtraction = prompt.includes('你是知识提取专家');
  if (!isMultiRepo && !isKnowledgeExtraction) return false;

  if (isKnowledgeExtraction) {
    const title = prompt.includes('E2E_IMPL_A') || prompt.includes('请确认继续实现 A')
      ? 'E2E_IMPL_A_KNOWLEDGE'
      : prompt.includes('E2E_PLAN_COMPLETE')
        ? 'E2E_PLAN_KNOWLEDGE'
        : null;
    if (title === 'E2E_IMPL_A_KNOWLEDGE') execFileSync('sleep', ['8']);
    process.stdout.write(JSON.stringify({
      entries: title ? [{
        type: 'guideline',
        title,
        content: '问题：多仓需求如果把全部实现派到第一仓，会在错误仓库产生提交并丢失交付证据。根因：规划任务没有显式绑定交付腿，后续派生只能猜测仓库。处理：逐任务记录仓库、腿分支和验收标准，确认后再派生实现 WU；每个实现 WU 从对应腿分支建立独立 worktree，只提交本任务文件并运行测试。评审通过后先合并到对应集成腿，再核对 merge receipt 和目标分支验证结果，不能把 agent 自报完成当作交付完成。最后由整体评审核对跨仓接口与证据，按腿分别记录交付 commit；任何一步失败都保留实际 Git 状态，重启后先对账再恢复，避免重复消息、重复评审或重复合并。',
        tags: ['e2e', 'multi-repo'],
      }] : [],
    }) + '\n');
    return true;
  }

  if (prompt.includes('整体评审') && prompt.includes('REVIEW_RESULT')) {
    streamResult('ACTION: COMPLETE: E2E_OVERALL_PASS\nREVIEW_RESULT: {"verdict":"pass","summary":"E2E_OVERALL_PASS","issues":[]}', `cli-overall-${Date.now()}`);
    return true;
  }

  if (prompt.includes('REVIEW_RESULT')) {
    streamResult('ACTION: COMPLETE: E2E_REVIEW_PASS\nREVIEW_RESULT: {"verdict":"pass","summary":"E2E_REVIEW_PASS","issues":[]}', `cli-review-${Date.now()}`);
    return true;
  }

  if (prompt.includes('规划需求 PMO-')) {
    const sessionId = process.argv.includes('--session')
      ? process.argv[process.argv.indexOf('--session') + 1]
      : `cli-plan-${Date.now()}`;
    if (!prompt.includes('## 人类新回复')) {
      streamResult('ACTION: NEED_INPUT: 请确认按两个指定仓库分别实施。', sessionId);
      return true;
    }
    const legs = [...prompt.matchAll(/^- LEG: (.+?) \| DELIVERY BRANCH: (.+)$/gm)];
    if (legs.length !== 2) {
      streamResult('ACTION: NEED_INPUT: 规划输入缺少两个明确交付腿。', sessionId);
      return true;
    }
    const tasks = legs.map((leg, index) => {
      const task = index === 0 ? 'A' : 'B';
      return `TASK: E2E_TASK_${task} 实现 ${task} | LEG: ${leg[1]} | AC: ${task} 实现及测试通过 | BLOCKEDBY: none`;
    });
    streamResult(`${tasks.join('\n')}\nACTION: COMPLETE: E2E_PLAN_COMPLETE`, sessionId);
    return true;
  }

  const task = prompt.includes('E2E_TASK_A') ? 'A' : prompt.includes('E2E_TASK_B') ? 'B' : null;
  if (!task) return false;
  const hasHumanReply = prompt.includes('## 人类新回复');
  const resumedSession = process.argv.includes('--session')
    ? process.argv[process.argv.indexOf('--session') + 1]
    : null;
  if (!hasHumanReply) {
    streamResult(`ACTION: NEED_INPUT: 请确认继续实现 ${task}。`, resumedSession ?? `cli-task-${task}-${Date.now()}`);
    return true;
  }

  if (task === 'A' && resumedSession) {
    streamResult(`Session not found: ${resumedSession}`, resumedSession, true);
    return true;
  }

  try {
    commitMultiRepoImplementation(task);
  } catch { /* 重试时提交已存在；完成守卫会核查真实 Git 状态。 */ }
  const sessionId = `cli-task-${task}-replacement-${Date.now()}`;
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: process.cwd(), encoding: 'utf-8',
  }).trim();
  const knowledgeSeen = prompt.includes('E2E_PLAN_KNOWLEDGE');
  const recoverySeen = prompt.includes('## 恢复包');
  streamResult(
    `ACTION: COMPLETE: E2E_IMPL_${task} cwd=${process.cwd()} commonDir=${commonDir} cli=${sessionId} PLAN_KB_SEEN=${knowledgeSeen} RECOVERY_SEEN=${recoverySeen}`,
    sessionId,
  );
  return true;
}

process.stdin.on('end', () => {
  if (runMultiRepoFlow()) return;
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
